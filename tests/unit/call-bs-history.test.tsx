import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { buildCallBsHistory, computeHeadToHead, outcomeForUser, type ResolvedChallengeRow } from "@/lib/challenges/history";
import { CallBsRecordLine, HeadToHeadLine } from "@/components/profile/CallBsRecordLine";
import { CallBsHistory } from "@/components/profile/CallBsHistory";

afterEach(() => cleanup());

const ANDRE = "a0000000-0000-4000-8000-000000000001";
const CARLOS = "c0000000-0000-4000-8000-000000000002";
const MARCO = "d0000000-0000-4000-8000-000000000003";

function row(overrides: Partial<ResolvedChallengeRow> = {}): ResolvedChallengeRow {
  return {
    id: "ch-1",
    market_id: "m-1",
    challenger_user_id: ANDRE,
    recipient_user_id: CARLOS,
    challenger_prediction_id: "pick-andre-1",
    recipient_prediction_id: "pick-carlos-1",
    challenger_selection_snapshot: "YES",
    recipient_selection_snapshot: "NO",
    result: "CHALLENGER_WON",
    resolved_at: "2026-10-04T16:52:00Z",
    ...overrides,
  };
}

describe("outcomeForUser — decided only from the stored winner", () => {
  it("challenger perspective", () => {
    expect(outcomeForUser(row({ result: "CHALLENGER_WON" }), ANDRE)).toBe("WON");
    expect(outcomeForUser(row({ result: "RECIPIENT_WON" }), ANDRE)).toBe("LOST");
  });
  it("recipient perspective is the mirror image", () => {
    expect(outcomeForUser(row({ result: "CHALLENGER_WON" }), CARLOS)).toBe("LOST");
    expect(outcomeForUser(row({ result: "RECIPIENT_WON" }), CARLOS)).toBe("WON");
  });
  it("VOID is neither a win nor a loss for anyone", () => {
    expect(outcomeForUser(row({ result: "VOID" }), ANDRE)).toBe("VOID");
    expect(outcomeForUser(row({ result: "VOID" }), CARLOS)).toBe("VOID");
  });
});

describe("computeHeadToHead", () => {
  it("is 0-0 with no resolved history", () => {
    expect(computeHeadToHead([], ANDRE)).toEqual({ wins: 0, losses: 0, voids: 0 });
  });

  it("counts a win and a loss from each side — the same challenges, mirrored", () => {
    const rows = [
      row({ id: "1", challenger_prediction_id: "a1", recipient_prediction_id: "c1", result: "CHALLENGER_WON" }),
      row({ id: "2", challenger_prediction_id: "a2", recipient_prediction_id: "c2", result: "CHALLENGER_WON" }),
      row({ id: "3", challenger_user_id: CARLOS, recipient_user_id: ANDRE, challenger_prediction_id: "c3", recipient_prediction_id: "a3", result: "CHALLENGER_WON" }),
    ];
    expect(computeHeadToHead(rows, ANDRE)).toEqual({ wins: 2, losses: 1, voids: 0 });
    expect(computeHeadToHead(rows, CARLOS)).toEqual({ wins: 1, losses: 2, voids: 0 });
  });

  it("keeps VOID out of wins and losses but still tallies it", () => {
    const rows = [row({ id: "1", challenger_prediction_id: "a1", result: "VOID" }), row({ id: "2", challenger_prediction_id: "a2", result: "RECIPIENT_WON" })];
    expect(computeHeadToHead(rows, ANDRE)).toEqual({ wins: 0, losses: 1, voids: 1 });
  });

  it("counts one Pick against one opponent once, however many times it was challenged and resolved (the locked reputation rule)", () => {
    const rows = [
      row({ id: "1", challenger_prediction_id: "a1", recipient_prediction_id: "c1" }),
      row({ id: "2", challenger_prediction_id: "a1", recipient_prediction_id: "c1b" }), // same Pick of André's, resolved again
      row({ id: "3", challenger_prediction_id: "a1", recipient_prediction_id: "c1c" }),
    ];
    expect(computeHeadToHead(rows, ANDRE)).toEqual({ wins: 1, losses: 0, voids: 0 });
  });
});

describe("buildCallBsHistory", () => {
  const profiles = [
    { id: CARLOS, username: "carlos", display_name: "Carlos", is_active: true },
    { id: MARCO, username: "marco", display_name: "Marco", is_active: false },
  ];
  const markets = [
    { id: "m-1", question: "Will the Washington Commanders win?", fixture_id: "f-1", price_outcome_labels: { yes: "Washington Commanders win", no: "Washington Commanders do not win" } },
    { id: "m-2", question: "Will the Bears win?", fixture_id: "f-2", price_outcome_labels: { yes: "Bears win", no: "Bears do not win" } },
  ];
  const fixtures = [
    { id: "f-1", sport: "american_football", home_team_name: "Washington Commanders", away_team_name: "Indianapolis Colts" },
    { id: "f-2", sport: "american_football", home_team_name: "Chicago Bears", away_team_name: "New York Jets" },
  ];
  const postIdByFixtureId = new Map([["f-1", "post-1"]]);

  it("renders opponent, canonical Game, Market question, the user's own Pick in the Market's words, result, time and the Post", () => {
    const [entry] = buildCallBsHistory({ rows: [row()], userId: ANDRE, profiles, markets, fixtures, postIdByFixtureId });
    expect(entry).toMatchObject({
      outcome: "WON",
      resolvedAt: "2026-10-04T16:52:00Z",
      opponent: { id: CARLOS, label: "Carlos", username: "carlos", known: true },
      game: { label: "Indianapolis Colts @ Washington Commanders", known: true },
      question: "Will the Washington Commanders win?",
      pickLabel: "Washington Commanders win", // André's own snapshot (YES)
      postId: "post-1",
    });
  });

  it("uses the recipient's own snapshot when the user is the recipient", () => {
    const [entry] = buildCallBsHistory({ rows: [row()], userId: CARLOS, profiles, markets, fixtures, postIdByFixtureId });
    expect(entry.pickLabel).toBe("Washington Commanders do not win");
    expect(entry.outcome).toBe("LOST");
    expect(entry.opponent.label).toBe("Unavailable user"); // André isn't in this fixture's profile list
  });

  it("an unavailable (missing or deactivated) opponent reads 'Unavailable user' and still keeps the result", () => {
    const rows = [row({ id: "gone", recipient_user_id: "ffffffff-0000-4000-8000-000000000009" }), row({ id: "off", recipient_user_id: MARCO })];
    const [gone, off] = buildCallBsHistory({ rows, userId: ANDRE, profiles, markets, fixtures, postIdByFixtureId });
    expect(gone.opponent).toMatchObject({ label: "Unavailable user", username: null, known: false });
    expect(off.opponent).toMatchObject({ label: "Unavailable user", username: null, known: false });
    expect(gone.outcome).toBe("WON");
    expect(off.resolvedAt).toBe("2026-10-04T16:52:00Z");
  });

  it("a missing Market or Game degrades to 'Unavailable game' with no Post link, keeping opponent, result and date", () => {
    const rows = [row({ id: "nomarket", market_id: "m-missing" }), row({ id: "nofixture", market_id: "m-3" })];
    const [a, b] = buildCallBsHistory({ rows, userId: ANDRE, profiles, markets: [...markets, { id: "m-3", question: "Orphan", fixture_id: null, price_outcome_labels: null }], fixtures, postIdByFixtureId });
    expect(a).toMatchObject({ game: { label: "Unavailable game", known: false }, question: null, pickLabel: null, postId: null, outcome: "WON", opponent: { label: "Carlos" } });
    expect(b).toMatchObject({ game: { label: "Unavailable game", known: false }, question: "Orphan", postId: null });
  });

  it("keeps the order it is given (the query sorts newest resolution first) and has no Post link when a Game has no published Post", () => {
    const rows = [row({ id: "newer", market_id: "m-2", resolved_at: "2026-10-05T00:00:00Z" }), row({ id: "older", resolved_at: "2026-10-04T00:00:00Z" })];
    const entries = buildCallBsHistory({ rows, userId: ANDRE, profiles, markets, fixtures, postIdByFixtureId });
    expect(entries.map((e) => e.challengeId)).toEqual(["newer", "older"]);
    expect(entries[0].postId).toBeNull(); // f-2 has no Post
    expect(entries[1].postId).toBe("post-1");
  });

  it("shows VOID as VOID", () => {
    const [entry] = buildCallBsHistory({ rows: [row({ result: "VOID" })], userId: ANDRE, profiles, markets, fixtures, postIdByFixtureId });
    expect(entry.outcome).toBe("VOID");
  });
});

describe("CallBsRecordLine", () => {
  it("shows 'Call BS: 8–4' visibly and 'Call BS record: 8 wins, 4 losses' to a screen reader", () => {
    render(<CallBsRecordLine wins={8} losses={4} />);
    expect(screen.getByText("Call BS record: 8 wins, 4 losses")).toHaveClass("sr-only");
    expect(screen.getByText(/Call BS: 8–4/)).toHaveAttribute("aria-hidden", "true");
  });
  it("uses the singular for one", () => {
    render(<CallBsRecordLine wins={1} losses={1} />);
    expect(screen.getByText("Call BS record: 1 win, 1 loss")).toBeInTheDocument();
  });
  it("renders nothing for 0–0 — no noisy empty record — and never a percentage or rank", () => {
    const { container } = render(<CallBsRecordLine wins={0} losses={0} />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    const { container: c2 } = render(<CallBsRecordLine wins={8} losses={4} />);
    expect(c2.textContent).not.toMatch(/%|rank|xp|tier|rating|score/i);
  });
});

describe("HeadToHeadLine", () => {
  it("names the opponent, reads 'Your Call BS record vs Carlos: 2–1', and is spoken in words", () => {
    render(<HeadToHeadLine opponentName="Carlos" wins={2} losses={1} />);
    expect(screen.getByText("Your Call BS record against Carlos: 2 wins, 1 loss")).toHaveClass("sr-only");
    expect(screen.getByText(/Your Call BS record vs Carlos: 2–1/)).toBeInTheDocument();
  });
  it("is absent when the two of you have no resolved history", () => {
    const { container } = render(<HeadToHeadLine opponentName="Carlos" wins={0} losses={0} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("CallBsHistory section", () => {
  const entries = buildCallBsHistory({
    rows: [row({ id: "w", result: "CHALLENGER_WON" }), row({ id: "l", market_id: "m-2", challenger_prediction_id: "a2", result: "RECIPIENT_WON", resolved_at: "2026-10-03T12:00:00Z" }), row({ id: "v", challenger_prediction_id: "a3", result: "VOID", resolved_at: "2026-10-02T12:00:00Z" })],
    userId: ANDRE,
    profiles: [{ id: CARLOS, username: "carlos", display_name: "Carlos", is_active: true }],
    markets: [
      { id: "m-1", question: "Will the Washington Commanders win?", fixture_id: "f-1", price_outcome_labels: { yes: "Washington Commanders win", no: "Washington Commanders do not win" } },
      { id: "m-2", question: "Will the Bears win?", fixture_id: "f-2", price_outcome_labels: { yes: "Bears win", no: "Bears do not win" } },
    ],
    fixtures: [
      { id: "f-1", sport: "american_football", home_team_name: "Washington Commanders", away_team_name: "Indianapolis Colts" },
      { id: "f-2", sport: "american_football", home_team_name: "Chicago Bears", away_team_name: "New York Jets" },
    ],
    postIdByFixtureId: new Map([["f-1", "post-1"], ["f-2", "post-2"]]),
  });

  it("lists compact rows — opponent, Game, question, pick, result in words, date — each Game linking to its Post", () => {
    render(<CallBsHistory entries={entries} subjectIsViewer subjectName="André" />);
    expect(screen.getByRole("heading", { level: 2, name: "Call BS" })).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText("Won")).toBeInTheDocument();
    expect(within(items[1]).getByText("Lost")).toBeInTheDocument();
    expect(within(items[2]).getByText("Void")).toBeInTheDocument();
    expect(items[0]).toHaveTextContent("vs Carlos");
    expect(items[0]).toHaveTextContent("Will the Washington Commanders win?");
    expect(items[0]).toHaveTextContent("You picked Washington Commanders win");
    expect(within(items[0]).getByRole("link", { name: "Open the Game: Indianapolis Colts @ Washington Commanders" })).toHaveAttribute("href", "/post/post-1");
    expect(within(items[0]).getByRole("link", { name: "Open Carlos's profile" })).toHaveAttribute("href", "/profile/carlos");
    // The result is a word, never colour alone.
    expect(within(items[0]).getByText("Result:")).toHaveClass("sr-only");
  });

  it("reads 'Picked …' on someone else's Profile and shows the viewer's record against them", () => {
    render(<CallBsHistory entries={entries} subjectIsViewer={false} subjectName="Carlos" headToHead={{ wins: 2, losses: 1, voids: 0 }} />);
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent(/Picked Washington Commanders win/);
    expect(screen.getAllByRole("listitem")[0]).not.toHaveTextContent("You picked");
    expect(screen.getByText(/Your Call BS record vs Carlos: 2–1/)).toBeInTheDocument();
  });

  it("does not show a head-to-head line on your own Profile or with no shared history", () => {
    const { container } = render(<CallBsHistory entries={entries} subjectIsViewer subjectName="André" headToHead={{ wins: 2, losses: 1, voids: 0 }} />);
    expect(container.textContent).not.toMatch(/vs André|record vs/);
    cleanup();
    const other = render(<CallBsHistory entries={entries} subjectIsViewer={false} subjectName="Carlos" headToHead={{ wins: 0, losses: 0, voids: 0 }} />);
    expect(other.container.textContent).not.toMatch(/0–0/);
  });

  it("has a restrained empty state, no table and no ranking furniture", () => {
    const { container } = render(<CallBsHistory entries={[]} subjectIsViewer subjectName="André" />);
    expect(screen.getByText("No Call BS results yet.")).toBeInTheDocument();
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).not.toMatch(/rank|xp|tier|badge|trophy|achievement|leaderboard/i);
  });

  it("shows an unavailable opponent and Game plainly, with no link to a missing Post", () => {
    const orphan = buildCallBsHistory({ rows: [row({ id: "x", recipient_user_id: "ffffffff-0000-4000-8000-000000000009", market_id: "gone" })], userId: ANDRE, profiles: [], markets: [], fixtures: [], postIdByFixtureId: new Map() });
    render(<CallBsHistory entries={orphan} subjectIsViewer subjectName="André" />);
    const item = screen.getByRole("listitem");
    expect(item).toHaveTextContent("vs Unavailable user");
    expect(item).toHaveTextContent("Unavailable game");
    expect(within(item).queryAllByRole("link")).toHaveLength(0);
    expect(within(item).getByText("Won")).toBeInTheDocument();
  });
});
