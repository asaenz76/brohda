import { describe, expect, it, vi, beforeEach } from "vitest";

// A minimal fluent query-builder fake — every chained call (select/eq/in)
// just returns the same builder; the builder itself is thenable (resolves
// to { data }), and .single()/.maybeSingle() resolve to the first row.
// This test is about getPoolPublishFollowRecipients's own dedupe/OR-ing
// logic, not Postgres's filtering, so each table's mock data is already
// "pre-filtered" as if the real query had run.
function makeQueryResult(data: unknown) {
  const builder: PromiseLike<{ data: unknown }> & {
    select: () => typeof builder;
    eq: () => typeof builder;
    in: () => typeof builder;
    single: () => Promise<{ data: unknown }>;
    maybeSingle: () => Promise<{ data: unknown }>;
  } = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    single: async () => ({ data: Array.isArray(data) ? (data[0] ?? null) : data }),
    maybeSingle: async () => ({ data: Array.isArray(data) ? (data[0] ?? null) : data }),
    then: (resolve) => Promise.resolve({ data }).then(resolve),
  };
  return builder;
}

let tableData: Record<string, unknown> = {};
const fromSpy = vi.fn((table: string) => makeQueryResult(tableData[table]));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromSpy }),
}));

const { getPoolPublishFollowRecipients } = await import("@/lib/pools/follow-recipients");

beforeEach(() => {
  fromSpy.mockClear();
  tableData = {};
});

describe("getPoolPublishFollowRecipients", () => {
  it("returns empty without querying when fixtureId is null (CUSTOM/COMBO pool)", async () => {
    const result = await getPoolPublishFollowRecipients(null);
    expect(result).toEqual([]);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("returns empty when the fixture has no matching team or league", async () => {
    tableData = {
      fixtures: {
        provider: "api_football",
        home_team_external_id: "10",
        away_team_external_id: "20",
        competition_external_id: "99",
      },
      teams: [],
      leagues: null,
      team_follows: [],
      league_follows: [],
    };

    const result = await getPoolPublishFollowRecipients("fixture-1");
    expect(result).toEqual([]);
  });

  it("dedupes a user following both the home and away team into one recipient", async () => {
    tableData = {
      fixtures: {
        provider: "api_football",
        home_team_external_id: "10",
        away_team_external_id: "20",
        competition_external_id: null,
      },
      teams: [
        { id: "team-home" },
        { id: "team-away" },
      ],
      leagues: null,
      team_follows: [
        { user_id: "user-1", email_enabled: true, team_id: "team-home" },
        { user_id: "user-1", email_enabled: true, team_id: "team-away" },
      ],
      league_follows: [],
    };

    const result = await getPoolPublishFollowRecipients("fixture-1");
    expect(result).toEqual([{ userId: "user-1", emailEnabled: true }]);
  });

  it("ORs email_enabled across matches — team follow with email off + league follow with email on still emails", async () => {
    tableData = {
      fixtures: {
        provider: "api_football",
        home_team_external_id: "10",
        away_team_external_id: null,
        competition_external_id: "99",
      },
      teams: [{ id: "team-home" }],
      leagues: { id: "league-1" },
      team_follows: [{ user_id: "user-1", email_enabled: false }],
      league_follows: [{ user_id: "user-1", email_enabled: true }],
    };

    const result = await getPoolPublishFollowRecipients("fixture-1");
    expect(result).toEqual([{ userId: "user-1", emailEnabled: true }]);
  });

  it("returns emailEnabled: false for a user whose only matching follow has email off", async () => {
    tableData = {
      fixtures: {
        provider: "api_football",
        home_team_external_id: "10",
        away_team_external_id: null,
        competition_external_id: null,
      },
      teams: [{ id: "team-home" }],
      leagues: null,
      team_follows: [{ user_id: "user-1", email_enabled: false }],
      league_follows: [],
    };

    const result = await getPoolPublishFollowRecipients("fixture-1");
    expect(result).toEqual([{ userId: "user-1", emailEnabled: false }]);
  });
});
