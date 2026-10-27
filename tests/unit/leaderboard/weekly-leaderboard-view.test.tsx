import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));
vi.mock("next/image", () => ({ default: (props: { alt: string }) => <span role="img" aria-label={props.alt} /> }));

import { WeeklyLeaderboardView } from "@/components/leaderboard/WeeklyLeaderboardView";
import type { LeaderboardEntry, WeeklyLeaderboard } from "@/lib/leaderboard/types";

afterEach(() => cleanup());

const entry = (over: Partial<LeaderboardEntry>): LeaderboardEntry => ({ rank: 1, tied: false, userId: "u1", displayName: "Maria", username: "maria", avatarUrl: null, correct: 8, incorrect: 2, decided: 10, accuracy: 0.8, ...over });
const board = (over: Partial<WeeklyLeaderboard> = {}): WeeklyLeaderboard => ({
  weekStart: "2026-10-26T06:00:00+00:00",
  weekEnd: "2026-11-02T06:00:00+00:00",
  minDecided: 5,
  topN: 20,
  totalRanked: 3,
  entries: [entry({}), entry({ rank: 2, userId: "u2", displayName: "Luis", username: "luis", correct: 5, incorrect: 0, decided: 5, accuracy: 1 }), entry({ rank: 3, tied: true, userId: "u3", displayName: "Ana", username: null, correct: 4, incorrect: 1, decided: 5, accuracy: 0.8 })],
  viewer: null,
  ...over,
});
const NOW = new Date("2026-10-29T12:00:00Z");

describe("WeeklyLeaderboardView", () => {
  it("reads in five seconds: the week, the rule, then each Member's rank, raw record and accuracy", () => {
    render(<WeeklyLeaderboardView board={board()} viewerUserId="me" now={NOW} />);
    expect(screen.getByRole("heading", { name: "Weekly leaderboard" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="leaderboard-week"]')).toHaveTextContent("Oct 26 – Nov 1 · 3 days left · resets Monday 12:00 AM Costa Rica time");
    expect(document.querySelector('[data-slot="leaderboard-rule"]')).toHaveTextContent("5 decided Picks this week to qualify. Ranked by accuracy, then most correct.");
    const rows = within(screen.getByRole("list", { name: /Weekly leaderboard, top 3/ })).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("#1");
    expect(rows[0]).toHaveTextContent("Maria");
    expect(rows[0]).toHaveTextContent("8–2");
    expect(rows[0]).toHaveTextContent("80%");
    expect(rows[1]).toHaveTextContent("5–0");
    expect(rows[1]).toHaveTextContent("100%");
  });

  it("links a Member to their profile (by username only, never an id) and says when a record is tied", () => {
    render(<WeeklyLeaderboardView board={board()} viewerUserId="me" now={NOW} />);
    expect(screen.getByRole("link", { name: /Maria/ })).toHaveAttribute("href", "/profile/maria");
    expect(screen.queryByRole("link", { name: /Ana/ })).toBeNull(); // no username, no link — and no id in any href
    expect(screen.getByText("Tied")).toBeInTheDocument();
    for (const a of document.querySelectorAll("a")) expect(a.getAttribute("href")).not.toMatch(/u1|u2|u3/);
  });

  it("marks the viewer's own row and links it to their own profile", () => {
    render(<WeeklyLeaderboardView board={board({ viewer: { eligible: true, ranked: true, rank: 2, correct: 5, incorrect: 0, decided: 5, accuracy: 1, needed: 0 } })} viewerUserId="u2" now={NOW} />);
    const mine = document.querySelector('[data-viewer="true"]')!;
    expect(mine).toHaveTextContent("Luis");
    expect(mine).toHaveTextContent("You");
    expect(within(mine as HTMLElement).getByRole("link")).toHaveAttribute("href", "/profile");
    expect(document.querySelector('[data-slot="leaderboard-me"]')).toHaveTextContent("#2");
    expect(document.querySelector('[data-slot="leaderboard-me"]')).toHaveTextContent("5–0");
    expect(document.querySelector('[data-slot="leaderboard-me"]')).toHaveTextContent("qualified");
  });

  it("shows a ranked Member who is outside the top N their own position, record and the total", () => {
    render(<WeeklyLeaderboardView board={board({ totalRanked: 52, viewer: { eligible: true, ranked: true, rank: 37, correct: 6, incorrect: 4, decided: 10, accuracy: 0.6, needed: 0 } })} viewerUserId="me" now={NOW} />);
    const me = document.querySelector('[data-slot="leaderboard-me"]')!;
    expect(me).toHaveTextContent("#37");
    expect(me).toHaveTextContent("6–4");
    expect(me).toHaveTextContent("60%");
    expect(me).toHaveTextContent("of 52 ranked");
    expect(document.querySelector('[data-slot="leaderboard-outside"]')).toHaveTextContent("#37 of 52 ranked this week, below the top 3 shown.");
  });

  it("shows an unqualified Member their progress, not a rank — and never lists them as ranked", () => {
    render(<WeeklyLeaderboardView board={board({ viewer: { eligible: true, ranked: false, rank: null, correct: 2, incorrect: 1, decided: 3, accuracy: 0.6667, needed: 2 } })} viewerUserId="me" now={NOW} />);
    const me = document.querySelector('[data-slot="leaderboard-me"]')!;
    expect(me).toHaveAttribute("data-state", "unqualified");
    expect(me).toHaveTextContent("3 of 5 Picks needed to qualify");
    expect(me).toHaveTextContent("You need 2 more Picks");
    expect(me).toHaveTextContent("2–1");
    expect(me).toHaveTextContent("Not ranked yet");
    expect(me).not.toHaveTextContent(/#\d/);
    expect(screen.getByRole("link", { name: "Make a Pick" })).toHaveAttribute("href", "/feed");
  });

  it("tells a Member with no picks this week what to do, and says staff accounts are not ranked", () => {
    const { unmount } = render(<WeeklyLeaderboardView board={board({ viewer: { eligible: true, ranked: false, rank: null, correct: 0, incorrect: 0, decided: 0, accuracy: null, needed: 5 } })} viewerUserId="me" now={NOW} />);
    expect(document.querySelector('[data-slot="leaderboard-me"]')).toHaveTextContent("0 of 5 Picks needed to qualify");
    expect(document.querySelector('[data-slot="leaderboard-me"]')).not.toHaveTextContent("This week:");
    unmount();
    render(<WeeklyLeaderboardView board={board({ viewer: { eligible: false, reason: "not_ranked_account" } })} viewerUserId="me" now={NOW} />);
    expect(document.querySelector('[data-slot="leaderboard-me"]')).toHaveTextContent("Staff and deactivated accounts aren't ranked.");
  });

  it("has a useful empty state when nobody has qualified, and a leaderboard of one is still a leaderboard", () => {
    const { unmount } = render(<WeeklyLeaderboardView board={board({ entries: [], totalRanked: 0 })} viewerUserId="me" now={NOW} />);
    expect(screen.getByText("No one has qualified yet this week.")).toBeInTheDocument();
    expect(screen.getByText(/The first Member to make 5 decided Picks takes #1\./)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    unmount();
    render(<WeeklyLeaderboardView board={board({ entries: [entry({})], totalRanked: 1 })} viewerUserId="me" now={NOW} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText("No one has qualified yet this week.")).toBeNull();
  });

  it("uses no points, prizes, betting or money language anywhere", () => {
    const { container } = render(<WeeklyLeaderboardView board={board({ viewer: { eligible: true, ranked: false, rank: null, correct: 1, incorrect: 0, decided: 1, accuracy: 1, needed: 4 } })} viewerUserId="me" now={NOW} />);
    expect(container.textContent).not.toMatch(/\bpoints?\b|\bxp\b|prize|reward|earn|\bbets?\b|betting|wager|\$|coins?|badge/i);
  });
});
