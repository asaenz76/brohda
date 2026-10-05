import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { buildAdminPredictionRows, listAdminPredictionRows, type AdminPredictionRaw } from "@/lib/predictions/admin-rows";
import { AdminPredictionsTable } from "@/components/admin/AdminPredictionsTable";

afterEach(() => cleanup());

const USER_A = "330c70a8-1111-4222-8333-444455556666";
const USER_B = "9f8e7d6c-1111-4222-8333-444455556666";
const MARKET_1 = "dfda3e6f-1111-4222-8333-444455556666";
const MARKET_2 = "0a0b0c0d-1111-4222-8333-444455556666";
const FIXTURE_1 = "f1f1f1f1-1111-4222-8333-444455556666";

function prediction(overrides: Partial<AdminPredictionRaw> = {}): AdminPredictionRaw {
  return {
    id: "p-1",
    user_id: USER_A,
    market_id: MARKET_1,
    selected_outcome: "YES",
    yes_probability_snapshot: 0.6,
    no_probability_snapshot: 0.4,
    lifecycle_state: "GRADED",
    result: "CORRECT",
    graded_at: "2026-10-04T16:50:00Z",
    created_at: "2026-10-02T15:00:00Z",
    ...overrides,
  };
}

const profiles = [
  { id: USER_A, username: "andre", display_name: "André Sáenz" },
  { id: USER_B, username: null, display_name: "Carlos F." },
];
const markets = [{ id: MARKET_1, question: "Will the Washington Commanders win?", fixture_id: FIXTURE_1 }];
const fixtures = [{ id: FIXTURE_1, sport: "american_football", home_team_name: "Washington Commanders", away_team_name: "Indianapolis Colts" }];

describe("buildAdminPredictionRows", () => {
  it("resolves username, the canonical Game (away @ home for American football), and the Market question — keeping the raw ids", () => {
    const [row] = buildAdminPredictionRows({ predictions: [prediction()], profiles, markets, fixtures });
    expect(row.user).toMatchObject({ primary: "andre", shortId: "330c70a8", id: USER_A, known: true });
    expect(row.match).toEqual({ primary: "Indianapolis Colts @ Washington Commanders", known: true });
    expect(row.market).toMatchObject({ primary: "Will the Washington Commanders win?", shortId: "dfda3e6f", id: MARKET_1, known: true });
    expect(row).toMatchObject({ selectedOutcome: "YES", yesPercent: 60, noPercent: 40, lifecycleState: "GRADED", result: "CORRECT" });
  });

  it("orders home-first with 'vs' for other sports", () => {
    const [row] = buildAdminPredictionRows({
      predictions: [prediction()],
      profiles,
      markets,
      fixtures: [{ ...fixtures[0], sport: "soccer" }],
    });
    expect(row.match.primary).toBe("Washington Commanders vs Indianapolis Colts");
  });

  it("falls back to the display name when there is no username, and never exposes an email field", () => {
    const [row] = buildAdminPredictionRows({ predictions: [prediction({ user_id: USER_B })], profiles, markets, fixtures });
    expect(row.user).toMatchObject({ primary: "Carlos F.", shortId: "9f8e7d6c", known: true });
    expect(JSON.stringify(row)).not.toMatch(/@.*\./); // no email-shaped value anywhere
  });

  it("degrades safely: unknown user, unknown market and unknown game still show the raw ids and don't throw", () => {
    const rows = buildAdminPredictionRows({
      predictions: [
        prediction({ id: "p-nouser", user_id: "deadbeef-1111-4222-8333-444455556666" }),
        prediction({ id: "p-nomarket", market_id: "cafef00d-1111-4222-8333-444455556666" }),
        prediction({ id: "p-nogame", market_id: MARKET_2 }),
      ],
      profiles,
      markets: [...markets, { id: MARKET_2, question: "Orphan market", fixture_id: null }],
      fixtures,
    });
    expect(rows[0].user).toMatchObject({ primary: "Unknown user", shortId: "deadbeef", known: false });
    expect(rows[1].market).toMatchObject({ primary: "Unknown market", shortId: "cafef00d", known: false });
    expect(rows[1].match).toEqual({ primary: "Unknown game", known: false });
    expect(rows[2].market).toMatchObject({ primary: "Orphan market", known: true });
    expect(rows[2].match).toEqual({ primary: "Unknown game", known: false });
  });
});

describe("AdminPredictionsTable", () => {
  const rows = buildAdminPredictionRows({
    predictions: [prediction(), prediction({ id: "p-2", user_id: "deadbeef-1111-4222-8333-444455556666", market_id: "cafef00d-1111-4222-8333-444455556666", result: null, graded_at: null, lifecycle_state: "PENDING" })],
    profiles,
    markets,
    fixtures,
  });

  it("keeps the existing columns in the preferred order", () => {
    render(<AdminPredictionsTable rows={rows} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Created",
      "User",
      "Match",
      "Market",
      "Selected",
      "Snapshot (YES / NO)",
      "State",
      "Result",
      "Graded",
    ]);
  });

  it("shows the human text first with the short id beneath, and the full id on hover", () => {
    render(<AdminPredictionsTable rows={rows} />);
    const first = screen.getAllByRole("row")[1];
    const cells = within(first).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("andre330c70a8");
    expect(within(cells[1]).getByTitle(USER_A)).toHaveTextContent("330c70a8");
    expect(cells[2]).toHaveTextContent("Indianapolis Colts @ Washington Commanders");
    expect(cells[3]).toHaveTextContent("Will the Washington Commanders win?dfda3e6f");
    expect(within(cells[3]).getByTitle(MARKET_1)).toHaveTextContent("dfda3e6f");
    // Truncated text carries its full value in the title.
    expect(within(cells[3]).getByText("Will the Washington Commanders win?")).toHaveAttribute("title", "Will the Washington Commanders win?");
  });

  it("renders an unresolvable row as Unknown + the raw id, without crashing", () => {
    render(<AdminPredictionsTable rows={rows} />);
    const second = screen.getAllByRole("row")[2];
    const cells = within(second).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent("Unknown userdeadbeef");
    expect(cells[2]).toHaveTextContent("Unknown game");
    expect(cells[3]).toHaveTextContent("Unknown marketcafef00d");
  });

  it("scrolls sideways at narrow widths instead of squashing columns, and shows the empty state", () => {
    const { container, rerender } = render(<AdminPredictionsTable rows={rows} />);
    expect(container.firstElementChild?.className).toContain("overflow-x-auto");
    expect(container.querySelector("table")?.className).toContain("min-w-[1040px]");
    rerender(<AdminPredictionsTable rows={[]} />);
    expect(screen.getByText("No predictions yet.")).toBeInTheDocument();
  });
});

// A fake PostgREST client: records every .in() id-list size so a too-long URL can't slip through unnoticed.
function fakeClient(predictions: AdminPredictionRaw[]) {
  const inSizes: Record<string, number[]> = {};
  const client = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.order = () => q;
      q.limit = () => q;
      q.in = (_column: string, ids: string[]) => {
        (inSizes[table] ??= []).push(ids.length);
        q.ids = ids;
        return q;
      };
      q.then = (resolve: (v: unknown) => unknown) => resolve({ data: table === "predictions" ? predictions : [], error: null });
      return q;
    },
  };
  return { client, inSizes };
}

describe("listAdminPredictionRows on a long page", () => {
  it("looks up users and markets in chunks of at most 150 ids (PostgREST's URL limit), never one giant .in()", async () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      prediction({ id: `p-${i}`, user_id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, market_id: `11111111-0000-0000-0000-${String(i).padStart(12, "0")}` }),
    );
    const { client, inSizes } = fakeClient(many);
    const rows = await listAdminPredictionRows(400, client as never);
    expect(rows).toHaveLength(400);
    expect(inSizes.user_profiles).toEqual([150, 150, 100]);
    expect(inSizes.markets).toEqual([150, 150, 100]);
    expect(Math.max(...Object.values(inSizes).flat())).toBeLessThanOrEqual(150);
    // Nothing resolved (the fake returns no profiles/markets): every row degrades to Unknown, none throws.
    expect(rows[0].user.primary).toBe("Unknown user");
    expect(rows[0].match.primary).toBe("Unknown game");
  });

  it("returns no rows without querying the lookup tables when there are no Predictions", async () => {
    const { client, inSizes } = fakeClient([]);
    expect(await listAdminPredictionRows(200, client as never)).toEqual([]);
    expect(inSizes).toEqual({});
  });

  it("throws a lookup error rather than silently showing Unknown rows", async () => {
    const failing = {
      from(table: string) {
        const q: Record<string, unknown> = {};
        q.select = () => q;
        q.order = () => q;
        q.limit = () => q;
        q.in = () => q;
        q.then = (resolve: (v: unknown) => unknown) =>
          resolve(table === "predictions" ? { data: [prediction()], error: null } : { data: null, error: { message: "boom" } });
        return q;
      },
    };
    await expect(listAdminPredictionRows(10, failing as never)).rejects.toMatchObject({ message: "boom" });
  });
});
