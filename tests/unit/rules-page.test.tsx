import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RulesContent } from "@/components/rules/RulesContent";
import { describeLockWindow, describeStakeLimits, formatDollars, formatFeePercent, UNKNOWN_RULES_POLICY, type RulesPolicy } from "@/lib/rules/format";

afterEach(() => cleanup());

const live: RulesPolicy = { lockMinutesBeforeKickoff: 10, feeBps: 100, minStakeCents: 100, maxStakeCents: 10_000, monetaryEnabled: true, callBsEnabled: true };
const text = (container: HTMLElement) => container.textContent ?? "";

describe("rules value formatting (pure)", () => {
  it("describes the cutoff from the live minutes, in singular/plural, or generically when unknown", () => {
    expect(describeLockWindow(10)).toBe("10 minutes before kickoff");
    expect(describeLockWindow(1)).toBe("1 minute before kickoff");
    expect(describeLockWindow(0)).toBe("at kickoff");
    expect(describeLockWindow(25)).toBe("25 minutes before kickoff");
    expect(describeLockWindow(null)).toBe("shortly before kickoff");
  });
  it("formats the fee from basis points", () => {
    expect(formatFeePercent(100)).toBe("1%");
    expect(formatFeePercent(150)).toBe("1.5%");
    expect(formatFeePercent(25)).toBe("0.25%");
    expect(formatFeePercent(0)).toBe("0%");
    expect(formatFeePercent(null)).toBeNull();
  });
  it("formats stake limits, and refuses an implausible or unknown pair", () => {
    expect(describeStakeLimits(100, 10_000)).toBe("between $1 and $100");
    expect(describeStakeLimits(250, 5_000)).toBe("between $2.50 and $50");
    expect(describeStakeLimits(5_000, 100)).toBeNull(); // max below min: don't print it
    expect(describeStakeLimits(null, 10_000)).toBeNull();
    expect(formatDollars(150)).toBe("$1.50");
  });
});

describe("RulesContent", () => {
  it("has one structure: the sections in order, each an h2 (the hosting page supplies the single h1)", () => {
    const { container } = render(<RulesContent policy={live} />);
    expect(container.querySelectorAll("h1")).toHaveLength(0);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "The basics",
      "Game Posts",
      "Picks",
      "When Picks lock",
      "Call BS",
      "Your prediction record",
      "Money",
      "Results and grading",
      "When a game can't be decided",
      "Comments and conduct",
      "Where these rules come from",
    ]);
    // Real lists, and sections are labelled regions.
    expect(container.querySelectorAll("ul").length).toBeGreaterThan(5);
    expect(screen.getAllByRole("region").length).toBe(11);
  });

  it("renders the live policy values: the cutoff, the fee and the stake limits", () => {
    const { container } = render(<RulesContent policy={{ ...live, lockMinutesBeforeKickoff: 15, feeBps: 250, minStakeCents: 500, maxStakeCents: 25_000 }} />);
    expect(text(container)).toContain("Picks lock 15 minutes before kickoff");
    expect(text(container)).toContain("The fee is currently 2.5%.");
    expect(text(container)).toContain("Each offer must be between $5 and $250.");
    // …and none of the old defaults leak in.
    expect(text(container)).not.toMatch(/10 minutes|\$100\b|currently 1%/);
  });

  it("goes generic — never a stale or invented number — when a value can't be read", () => {
    // Money on, but its fee and limits unreadable: the section stays and says so without inventing a number.
    const { container } = render(<RulesContent policy={{ ...UNKNOWN_RULES_POLICY, monetaryEnabled: true }} />);
    expect(text(container)).toContain("Picks lock shortly before kickoff");
    expect(text(container)).toContain("The fee rate is shown before you confirm an offer.");
    expect(text(container)).toContain("Each offer has a minimum and a maximum amount, shown when you make it.");
    // (The "67% prediction accuracy" and "Call BS: 8–4" lines are illustrative examples of the record's format, not policy values.)
    expect(text(container)).not.toMatch(/Picks lock \d|\d+ minutes? before|fee is currently|Each offer must be|between \$/);
    // No "switched off" claims when the switches are unknown either.
    expect(text(container)).not.toMatch(/switched off/);
  });

  it("says plainly when Call BS is currently switched off, and only then", () => {
    const off = render(<RulesContent policy={{ ...live, callBsEnabled: false }} />);
    expect(text(off.container)).toContain("Call BS is switched off right now.");
    off.unmount();
    const on = render(<RulesContent policy={live} />);
    expect(text(on.container)).not.toMatch(/switched off/);
  });

  it("states the hard authorship rule: Brohda publishes every Game Post, members never do", () => {
    const { container } = render(<RulesContent policy={live} />);
    expect(text(container)).toContain("Every Game Post is created by Brohda. Members can't create, edit or remove one.");
    expect(text(container)).toContain("Members don't publish games or Markets.");
    expect(text(container)).toContain("Members never create the games themselves.");
    expect(text(container)).not.toMatch(/create (a )?post|your (own )?game post|publish your/i);
  });

  it("matches the live Call BS rules: free, opposing Picks, no lock on send, one accepted per Market, lock on accept, others unavailable, graded from the Market", () => {
    const { container } = render(<RulesContent policy={live} />);
    const t = text(container);
    expect(t).toContain("free, head-to-head challenge between two people who picked opposite sides of the same Market");
    expect(t).toContain("Sending a Call BS doesn't lock either Pick");
    expect(t).toContain("several Call BS waiting at once");
    expect(t).toContain("only one accepted Call BS per Market");
    expect(t).toContain("Accepting locks both Picks right away");
    expect(t).toContain("every other waiting Call BS involving either of you on that Market becomes unavailable");
    expect(t).toContain("decided by the Market's result");
    // The visible record, and what doesn't count.
    expect(t).toContain("Call BS: 8–4");
    expect(t).toContain("Declined, expired and never-accepted Call BS don't count, and neither do voided ones.");
  });

  it("matches the live prediction record math: accuracy = correct ÷ (correct + incorrect), void excluded; predicted = graded Picks incl. void", () => {
    const { container } = render(<RulesContent policy={live} />);
    const t = text(container);
    expect(t).toContain("correct ÷ (correct + incorrect)");
    expect(t).toContain("Voided Picks are left out of it.");
    expect(t).toContain("graded, voided ones included");
    expect(t).toContain("Call BS and money never change it.");
  });

  it("matches the live money lifecycle: optional, separate from Call BS, hold on send, explicit accept that locks, one Position per pair, release on decline/withdraw/expiry, VOID releases with no fee", () => {
    const { container } = render(<RulesContent policy={live} />);
    const t = text(container);
    expect(t).toContain("Money is optional");
    expect(t).toContain("someone who picked the opposite side of the same Market");
    expect(t).toContain("Sending an offer holds your amount out of your available balance");
    expect(t).toContain("has to accept it themselves");
    expect(t).toContain("locks both Picks immediately");
    expect(t).toContain("at most one active money Position per Market");
    expect(t).toContain("different people on the same Market");
    expect(t).toContain("declined, withdrawn, or runs out at the cutoff, the amount held for it is released");
    expect(t).toContain("A voided money Position releases what was held on both sides. No fee is taken and nothing moves.");
    expect(t).toContain("The rate is fixed on a Position at the moment it's accepted.");
  });

  it("describes grading authority without overpromising data, and says comments and sentiment never affect it", () => {
    const { container } = render(<RulesContent policy={live} />);
    const t = text(container);
    expect(t).toContain("Comments, community sentiment and what most people picked don't affect grading.");
    expect(t).toContain("can't promise that data is perfect");
  });

  it("invents no moderation: moderators can remove comments, the Terms say what isn't allowed", () => {
    render(<RulesContent policy={live} />);
    const conduct = screen.getByRole("region", { name: "Comments and conduct" });
    expect(conduct).toHaveTextContent("moderators can remove comments");
    expect(within(conduct).getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
    expect(conduct.textContent).not.toMatch(/harass|threat|spam|ban|suspend/i);
  });

  it("stays separate from the legal documents: links to Terms and Privacy, carries no legal boilerplate, and no Pool-era words", () => {
    const { container } = render(<RulesContent policy={live} />);
    expect(screen.getAllByRole("link", { name: "Terms" }).every((a) => a.getAttribute("href") === "/terms")).toBe(true);
    expect(screen.getByRole("link", { name: "Privacy policy" })).toHaveAttribute("href", "/privacy");
    expect(text(container)).not.toMatch(/indemnif|governing law|liabilit|arbitration|you agree|hereby/i);
    expect(text(container)).not.toMatch(/\bpools?\b|leaderboard|analytics|wallet/i);
  });

  it("has no controls: no buttons, forms, inputs or textareas — nothing that can mutate anything", () => {
    const { container } = render(<RulesContent policy={live} />);
    expect(container.querySelectorAll("button, form, input, textarea, select")).toHaveLength(0);
  });
});

describe("RulesContent — optional money switched off (a complete free product)", () => {
  const off: RulesPolicy = { ...live, monetaryEnabled: false };

  it("drops the whole Money section and describes the free product, with nothing marking the gap", () => {
    const { container } = render(<RulesContent policy={off} />);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "The basics",
      "Game Posts",
      "Picks",
      "When Picks lock",
      "Call BS",
      "Your prediction record",
      "Results and grading",
      "When a game can't be decided",
      "Comments and conduct",
      "Where these rules come from",
    ]);
    expect(screen.getAllByRole("region")).toHaveLength(10);
    expect(text(container)).not.toMatch(/coming soon|disabled|switched off|not available|ask an admin/i);
  });

  it("carries no consumer money copy anywhere: stakes, fees, holds, funding, Positions, wallet, settlement, winnings", () => {
    const { container } = render(<RulesContent policy={off} />);
    expect(text(container)).not.toMatch(/\bmoney\b|\bstakes?\b|\bfees?\b|\bheld\b|\bon hold\b|\breserv|\bfund(s|ing)?\b|\bdeposit|\bwithdraw|\bposition|\bwallet\b|\bsettle|\bwinnings\b|\bbalance\b|\boffers?\b/i);
    expect(text(container)).not.toMatch(/\$\d/);
  });

  it("the rest still reads correctly without money: authorship, Picks, locking, Call BS, record, results and VOID", () => {
    const { container } = render(<RulesContent policy={off} />);
    const t = text(container);
    expect(t).toContain("Every Game Post is created by Brohda. Members can't create, edit or remove one.");
    expect(t).toContain("you take part with Picks, comments and Call BS. Members never create the games themselves.");
    expect(t).toContain("A Pick is free.");
    expect(t).toContain("Picks lock 10 minutes before kickoff");
    expect(t).toContain("accepting a Call BS locks the Picks involved immediately.");
    expect(t).toContain("Call BS is a head-to-head challenge between two people who picked opposite sides of the same Market.");
    expect(t).toContain("Call BS never changes it. Your prediction record comes only from your Picks.");
    expect(t).toContain("Call BS results follow from the Market’s result.");
    expect(t).toContain("A voided Call BS is neither a win nor a loss for either person.");
    expect(t).toContain("The cutoff quoted here is read from Brohda's live settings, so it stays current.");
  });

  it("fails closed: an unreadable money setting reads as off, so the Money section is hidden too", () => {
    const { container } = render(<RulesContent policy={UNKNOWN_RULES_POLICY} />);
    expect(screen.queryByRole("heading", { level: 2, name: "Money" })).toBeNull();
    expect(text(container)).not.toMatch(/\bmoney\b|\bfees?\b|\bstakes?\b/i);
  });

  it("with money on, the section is back with the live fee and limits (unchanged behaviour)", () => {
    render(<RulesContent policy={live} />);
    expect(screen.getByRole("heading", { level: 2, name: "Money" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Money" })).toHaveTextContent("The fee is currently 1%.");
  });
});
