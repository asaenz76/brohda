import { describe, expect, it } from "vitest";
import { buildAdminReport, buildSponsorReport, METRIC_KEYS, type RawAggregates } from "@/lib/sponsor-intelligence/report";

const label = (key: string) => key.toUpperCase();

function raw(overrides: Partial<RawAggregates> = {}): RawAggregates {
  return {
    sponsorshipId: "11111111-1111-4111-8111-111111111111",
    windowStart: "2026-10-10T00:00:00.000Z",
    windowEnd: "2026-10-11T00:00:00.000Z",
    started: true,
    impressions: 80,
    uniqueViewers: 40,
    repeatViewers: 18,
    clicks: 12,
    picks: 60,
    pickMembers: 30,
    viewersWhoPicked: 24,
    comments: 25,
    replies: 14,
    commenters: 15,
    callBsChallenges: 6,
    callBsAccepted: 4,
    callBsMembers: 8,
    callBsPickers: 8,
    returningMembers: 12,
    markets: [
      { marketId: "m1", template: "MONEYLINE", lineValue: null, yesSide: "HOME", members: 28, yesCount: 18, noCount: 10 },
      { marketId: "m2", template: "TOTAL", lineValue: 47.5, yesSide: null, members: 20, yesCount: 19, noCount: 1 },
      { marketId: "m3", template: "SPREAD", lineValue: 3.5, yesSide: "HOME", members: 4, yesCount: 3, noCount: 1 },
    ],
    game: { homeTeamName: "Chiefs", awayTeamName: "Ravens", sport: "american_football" },
    sportAffinity: [{ key: "american_football", count: 30 }, { key: "basketball", count: 3 }],
    teamAffinity: [{ key: "t1", label: "Chiefs", count: 14 }, { key: "t2", label: "Ravens", count: 2 }],
    affinityLookbackDays: 90,
    ...overrides,
  };
}

describe("buildSponsorReport", () => {
  it("shows large figures and withholds every figure under the threshold", () => {
    const r = buildSponsorReport(raw(), 10, label);
    expect(r.metrics.uniqueViewers).toBe(40);
    expect(r.metrics.impressions).toBe(80);
    expect(r.metrics.pickMembers).toBe(30);
    expect(r.metrics.commenters).toBe(15);
    expect(r.metrics.clicks).toBe(12);
    expect(r.metrics.callBsMembers).toBeNull(); // 8 < 10
    expect(r.metrics.callBsChallenges).toBeNull(); // follows the Members behind it
    expect(r.anySuppressed).toBe(true);
  });

  it("never exposes any number below the threshold anywhere in the report", () => {
    const k = 10;
    const r = buildSponsorReport(raw({ clicks: 3, comments: 7, commenters: 2 }), k, label);
    const numbers: number[] = [];
    for (const key of METRIC_KEYS) if (r.metrics[key] !== null) numbers.push(r.metrics[key] as number);
    for (const c of [...r.sportAffinity.cells, ...r.teamAffinity.cells]) numbers.push(c.count);
    if (r.sportAffinity.other !== null) numbers.push(r.sportAffinity.other);
    if (r.teamAffinity.other !== null) numbers.push(r.teamAffinity.other);
    expect(numbers.filter((n) => n > 0 && n < k)).toEqual([]);
  });

  it("an event total never shows when the Members behind it are a small group", () => {
    const r = buildSponsorReport(raw({ uniqueViewers: 3, impressions: 45, pickMembers: 4, picks: 30, commenters: 2, comments: 20 }), 10, label);
    expect(r.metrics.uniqueViewers).toBeNull();
    expect(r.metrics.impressions).toBeNull(); // 45 impressions would point at 3 people
    expect(r.metrics.picks).toBeNull();
    expect(r.metrics.comments).toBeNull();
  });

  it("'returning' is withheld when its remainder would reveal a small group", () => {
    expect(buildSponsorReport(raw({ pickMembers: 30, returningMembers: 29 }), 10, label).metrics.returningMembers).toBeNull();
    expect(buildSponsorReport(raw({ pickMembers: 30, returningMembers: 12 }), 10, label).metrics.returningMembers).toBe(12);
  });

  it("breakdowns hide small cells and label sports in words", () => {
    const r = buildSponsorReport(raw(), 10, label);
    expect(r.sportAffinity.cells.map((c) => c.label)).toEqual(["AMERICAN_FOOTBALL"]);
    expect(r.sportAffinity.other).toBeNull(); // the 3 is not shown, nor merged into a small 'Other'
    expect(r.teamAffinity.cells.map((c) => c.label)).toEqual(["Chiefs"]);
  });

  it("an empty campaign shows zeros (identifying nobody) and nothing is flagged withheld", () => {
    const r = buildSponsorReport(
      raw({ impressions: 0, uniqueViewers: 0, repeatViewers: 0, clicks: 0, picks: 0, pickMembers: 0, viewersWhoPicked: 0, comments: 0, replies: 0, commenters: 0, callBsChallenges: 0, callBsAccepted: 0, callBsMembers: 0, callBsPickers: 0, returningMembers: 0, markets: [], sportAffinity: [], teamAffinity: [] }),
      10,
      label,
    );
    for (const key of METRIC_KEYS) expect(r.metrics[key]).toBe(0);
    expect(r.anySuppressed).toBe(false);
  });

  it("carries only counts and labels — the report has no Member-level field of any kind", () => {
    const serialised = JSON.stringify(buildSponsorReport(raw(), 5, label));
    expect(serialised).not.toMatch(/user_?id|email|username|display_?name|@/i);
  });
});

describe("new V1 metrics", () => {
  it("repeat viewers and viewers who picked are subsets of the viewers, shown only when their remainders are safe", () => {
    const r = buildSponsorReport(raw({ uniqueViewers: 40, repeatViewers: 18, viewersWhoPicked: 24 }), 10, label);
    expect(r.metrics.repeatViewers).toBe(18);
    expect(r.metrics.viewersWhoPicked).toBe(24);
    // 38 of 40 repeated: the 2 who did not would be a small group.
    expect(buildSponsorReport(raw({ repeatViewers: 38 }), 10, label).metrics.repeatViewers).toBeNull();
    // A subset is withheld when its parent is.
    const small = buildSponsorReport(raw({ uniqueViewers: 4, repeatViewers: 0, viewersWhoPicked: 0 }), 10, label);
    expect(small.metrics.uniqueViewers).toBeNull();
    expect(small.metrics.repeatViewers).toBeNull();
  });

  it("derives percentages only from two figures that are both shown", () => {
    const r = buildSponsorReport(raw(), 10, label);
    expect(r.rates.participation).toBe(60); // 24 of 40 viewers
    expect(r.rates.callBsAcceptance).toBeNull(); // 6 challenges is below the threshold, so no rate
    expect(r.rates.callBsEngagement).toBeNull(); // only 8 pickers joined a Call BS: below the threshold
    expect(buildSponsorReport(raw({ callBsPickers: 12 }), 10, label).rates.callBsEngagement).toBe(40); // 12 of 30 pickers
    const big = buildSponsorReport(raw({ callBsChallenges: 30, callBsAccepted: 12, callBsMembers: 20 }), 10, label);
    expect(big.rates.callBsAcceptance).toBe(40);
    // 12 of 20 accepted would leave 8 who did not: that remainder is a small group, so neither the count nor the rate is shown.
    const revealing = buildSponsorReport(raw({ callBsChallenges: 20, callBsAccepted: 12, callBsMembers: 20 }), 10, label);
    expect(revealing.metrics.callBsAccepted).toBeNull();
    expect(revealing.rates.callBsAcceptance).toBeNull();
    // No denominator → no rate, never a fabricated 0%.
    const none = buildSponsorReport(raw({ uniqueViewers: 0, viewersWhoPicked: 0, repeatViewers: 0 }), 10, label);
    expect(none.rates.participation).toBe("none");
    // …and a rate whose figures are withheld stays withheld (null), which the page words differently from "nothing to measure".
    expect(buildSponsorReport(raw({ uniqueViewers: 4, viewersWhoPicked: 3 }), 10, label).rates.participation).toBeNull();
  });

  it("replies follow the Members behind them, like comments", () => {
    const r = buildSponsorReport(raw({ commenters: 3, comments: 20, replies: 30 }), 10, label);
    expect(r.metrics.comments).toBeNull();
    expect(r.metrics.replies).toBeNull();
    expect(buildSponsorReport(raw(), 10, label).metrics.replies).toBe(14);
  });

  it("labels each Market with the shared label helper and shows a split only when BOTH sides are large enough", () => {
    const r = buildSponsorReport(raw(), 10, label);
    const [moneyline, total, spread] = r.markets;
    expect(moneyline.label).toBe("Moneyline");
    expect(moneyline.members).toBe(28);
    expect(moneyline.sentiment).toHaveLength(2);
    expect(moneyline.sentiment!.map((c) => c.percent).sort()).toEqual([36, 64]); // 18 / 28 and 10 / 28
    expect(moneyline.sentiment!.map((c) => c.label)).toEqual(expect.arrayContaining(["Chiefs", "Ravens"]));
    expect(total.label).toBe("Total 47.5");
    expect(total.members).toBe(20);
    expect(total.sentiment).toBeNull(); // 19 / 1: the 1 would point at one person
    expect(spread.members).toBeNull(); // 4 Members: withheld
    expect(spread.sentiment).toBeNull();
  });

  it("never exposes a per-Market side count below the threshold", () => {
    const r = buildSponsorReport(raw(), 10, label);
    const shown = r.markets.flatMap((m) => (m.members === null ? [] : [m.members]));
    expect(shown.every((n) => n === 0 || n >= 10)).toBe(true);
    // Sentiment percentages are only present for Markets whose both sides were ≥ k, so no percentage can encode a count under k.
    for (const m of r.markets) if (m.sentiment) expect(m.members).not.toBeNull();
  });
});

describe("no monetary metric exists (Sponsor Intelligence measures attention and prediction behaviour, never Member money)", () => {
  it("neither the raw shape nor either view carries any wallet, stake, P2P, Position, fee or balance field", () => {
    const admin = buildAdminReport(raw(), 5, label);
    const keys = JSON.stringify([Object.keys(raw()), Object.keys(admin.sponsorView.metrics), Object.keys(admin.sponsorView.rates), Object.keys(admin), admin.sponsorView.markets.map((m) => Object.keys(m))]);
    expect(keys).not.toMatch(/wallet|stake|wager|monetary|position|p2p|deposit|withdraw|fee|settle|balance|payout|cash|usdt|currency|amount|price|revenue/i);
  });
});

describe("buildAdminReport", () => {
  it("keeps the exact figures and says which ones the Sponsor would not be shown", () => {
    const admin = buildAdminReport(raw(), 10, label);
    expect(admin.exact.callBsMembers).toBe(8);
    expect(admin.suppressedForSponsor).toContain("callBsMembers");
    expect(admin.suppressedForSponsor).not.toContain("uniqueViewers");
    expect(admin.sponsorView.metrics.callBsMembers).toBeNull();
  });
});
