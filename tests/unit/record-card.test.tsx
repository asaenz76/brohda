import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemberRecordSummary } from "@/lib/member-record/types";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { RecordCard } from "@/components/profile/RecordCard";
import { CompactUserIdentity, UserIdentity } from "@/components/identity/UserIdentity";

afterEach(() => cleanup());

const base: MemberRecordSummary = {
  correct: 30,
  incorrect: 34,
  void: 2,
  form: ["W", "W", "L", "W", "W", "L", "W", "W", "L", "W"],
  currentStreak: { kind: "CORRECT", length: 1 },
  bestCorrectStreak: 8,
  thisWeek: { correct: 6, incorrect: 2 },
  confidence: { picks: 12, correct: 9, incorrect: 3 },
  bySport: [
    { sport: "american_football", correct: 20, incorrect: 14, void: 1 },
    { sport: "basketball", correct: 10, incorrect: 20, void: 1 },
  ],
  bySeason: [{ sport: "american_football", season: "2026", correct: 20, incorrect: 14 }],
};
const props = { summary: base, callBs: { wins: 8, losses: 3, void: 1 }, opponents: [{ opponentId: "o1", name: "Maria", username: "maria", wins: 4, losses: 3, voids: 0, matchups: 7 }], minDecided: 5, subjectIsViewer: false };

describe("RecordCard", () => {
  it("leads with the raw record, then Call BS, form, streak, this week and Confidence — all as text", () => {
    render(<RecordCard {...props} />);
    const picks = screen.getByText("Picks").closest("div")!;
    expect(picks).toHaveTextContent("30–34");
    expect(picks).toHaveTextContent("47% correct");
    expect(picks).toHaveTextContent("2 void");
    expect(screen.getByText("Call BS").closest("div")).toHaveTextContent("8–3");
    expect(screen.getByText("Call BS").closest("div")).toHaveTextContent("73% won");
    expect(screen.getByText("Recent form").closest("div")).toHaveTextContent("7–3");
    expect(screen.getByRole("img", { name: /Most recent first: correct, correct, incorrect/ })).toBeInTheDocument();
    expect(screen.getByText("This week").closest("div")).toHaveTextContent("6–2");
    expect(screen.getByText("Backed with Confidence").closest("div")).toHaveTextContent("12 picks");
    expect(screen.getByText("Backed with Confidence").closest("div")).toHaveTextContent("9–3 decided");
    expect(screen.getByText("Last pick correct")).toBeInTheDocument();
    expect(screen.getByText("Streak").closest("div")).toHaveTextContent("Best: 8 correct in a row");
  });

  it("says the best run only when it is more than the current run (and more than one)", () => {
    const { unmount } = render(<RecordCard {...props} summary={{ ...base, currentStreak: { kind: "CORRECT", length: 8 }, bestCorrectStreak: 8 }} />);
    expect(screen.getByText("8 correct in a row")).toBeInTheDocument();
    expect(screen.queryByText(/Best:/)).toBeNull();
    unmount();
    render(<RecordCard {...props} summary={{ ...base, currentStreak: { kind: "INCORRECT", length: 3 }, bestCorrectStreak: 1 }} />);
    expect(screen.getByText("3 misses in a row")).toBeInTheDocument();
    expect(screen.queryByText(/Best:/)).toBeNull();
  });

  it("shows no percentage for a tiny sample, only the raw record (1–0 is not 100%)", () => {
    render(<RecordCard {...props} summary={{ ...base, correct: 1, incorrect: 0, void: 0, form: ["W"], bySport: [], bySeason: [], confidence: { picks: 0, correct: 0, incorrect: 0 }, thisWeek: { correct: 0, incorrect: 0 } }} callBs={{ wins: 1, losses: 0, void: 0 }} opponents={[]} />);
    expect(screen.getByText("Picks").closest("div")).toHaveTextContent("1–0");
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByText("Picks").closest("div")).toHaveTextContent("1 decided");
  });

  it("an empty record is an invitation, not a wall of zeros — own and someone else's", () => {
    const empty = { ...base, correct: 0, incorrect: 0, void: 0, form: [], currentStreak: null, bestCorrectStreak: 0, thisWeek: { correct: 0, incorrect: 0 }, confidence: { picks: 0, correct: 0, incorrect: 0 }, bySport: [], bySeason: [] };
    const { unmount } = render(<RecordCard {...props} summary={empty} callBs={{ wins: 0, losses: 0, void: 0 }} opponents={[]} subjectIsViewer />);
    expect(screen.getByText("Your record starts with your first pick.")).toBeInTheDocument();
    expect(screen.queryByText("0–0")).toBeNull();
    unmount();
    render(<RecordCard {...props} summary={empty} callBs={{ wins: 0, losses: 0, void: 0 }} opponents={[]} />);
    expect(screen.getByText("No graded picks yet.")).toBeInTheDocument();
  });

  it("omits Call BS, week, form and Confidence rows when there is nothing to say", () => {
    render(<RecordCard {...props} summary={{ ...base, form: [], currentStreak: null, thisWeek: { correct: 0, incorrect: 0 }, confidence: { picks: 0, correct: 0, incorrect: 0 } }} callBs={{ wins: 0, losses: 0, void: 0 }} opponents={[]} />);
    for (const label of ["Call BS", "Recent form", "Streak", "This week", "Backed with Confidence"]) expect(screen.queryByText(label)).toBeNull();
    expect(screen.getByText("Picks")).toBeInTheDocument();
  });

  it("breaks down by sport with the sample size, and shows seasons only when a sport spans more than one", () => {
    const { unmount } = render(<RecordCard {...props} />);
    const bySport = screen.getByText("By sport").closest("div")!;
    expect(within(bySport).getByText("NFL").closest("li")).toHaveTextContent("20–14");
    expect(within(bySport).getByText("NFL").closest("li")).toHaveTextContent("34 decided");
    expect(within(bySport).getByText("NBA").closest("li")).toHaveTextContent("10–20");
    expect(screen.queryByText("By season")).toBeNull(); // one season: the sport row already says it
    unmount();
    render(<RecordCard {...props} summary={{ ...base, bySeason: [{ sport: "american_football", season: "2026", correct: 12, incorrect: 8 }, { sport: "american_football", season: "2025", correct: 8, incorrect: 6 }] }} />);
    expect(screen.getByText("NFL 2026").closest("li")).toHaveTextContent("12–8");
    expect(screen.getByText("NFL 2025").closest("li")).toHaveTextContent("8–6");
  });

  it("lists the opponents played most, linking to their profiles, with the Member's record against each", () => {
    render(<RecordCard {...props} />);
    const link = screen.getByRole("link", { name: "Maria" });
    expect(link).toHaveAttribute("href", "/profile/maria");
    expect(link.closest("li")).toHaveTextContent("4–3");
    expect(link.closest("li")).toHaveTextContent("7 matchups");
    expect(screen.queryByText(/rival/i)).toBeNull(); // nobody is labelled a rival
  });

  it("uses no gambling or gamification language", () => {
    const { container } = render(<RecordCard {...props} />);
    expect(container.textContent).not.toMatch(/\b(bet|wager|stake|odds|payout|xp|level|badge|points)\b/i);
  });
});

describe("identity line for a tiny sample (comments, profile header)", () => {
  const tiny = { correct: 1, incorrect: 0, void: 0, decided: 1, accuracy: 1, minDecidedForLeaderboard: 5 };
  it("reads 1–0, not 100%", () => {
    render(<UserIdentity displayName="Ana" username="ana" avatarUrl={null} reputation={tiny} />);
    expect(screen.getByText("1–0 prediction record · 1 predicted")).toBeInTheDocument();
    expect(screen.queryByText(/100%/)).toBeNull();
  });
  it("compact form too", () => {
    render(<CompactUserIdentity displayName="Ana" avatarUrl={null} reputation={tiny} />);
    expect(screen.getByText(/1–0 · 1 predicted/)).toBeInTheDocument();
  });
  it("at the minimum the percentage returns", () => {
    render(<UserIdentity displayName="Ana" username="ana" avatarUrl={null} reputation={{ correct: 5, incorrect: 0, void: 0, decided: 5, accuracy: 1, minDecidedForLeaderboard: 5 }} />);
    expect(screen.getByText("100% prediction accuracy · 5 predicted")).toBeInTheDocument();
  });
});
