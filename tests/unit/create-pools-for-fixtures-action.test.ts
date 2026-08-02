import { beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_ADMIN = { id: "admin-1", role: "super_admin" as const };

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSuperAdmin: vi.fn(async () => FAKE_ADMIN) }));
vi.mock("@/lib/audit/log", () => ({ writeAuditLog: vi.fn(async () => {}) }));
vi.mock("@/lib/pools/follow-recipients", () => ({ getPoolPublishFollowRecipients: vi.fn(async () => []) }));
vi.mock("@/lib/notifications/create", () => ({
  createPoolPublishedFollowNotifications: vi.fn(async () => {}),
}));
vi.mock("@/lib/email/notify-followed-pool-published", () => ({
  notifyFollowedPoolPublished: vi.fn(async () => {}),
}));

let fixtureRows: Array<Record<string, unknown>> = [];
let poolInserts: Array<Record<string, unknown>> = [];
let optionInserts: Array<Array<Record<string, unknown>>> = [];
let poolIdCounter = 0;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "fixtures") {
        return { select: () => ({ in: async () => ({ data: fixtureRows, error: null }) }) };
      }
      if (table === "pools") {
        return {
          insert: (payload: Record<string, unknown>) => {
            poolInserts.push(payload);
            const id = `pool-${++poolIdCounter}`;
            return { select: () => ({ single: async () => ({ data: { id }, error: null }) }) };
          },
        };
      }
      if (table === "pool_options") {
        return {
          insert: async (rows: Array<Record<string, unknown>>) => {
            optionInserts.push(rows);
            return { error: null };
          },
        };
      }
      throw new Error(`Unexpected table in test: ${table}`);
    },
  }),
}));

const { createPoolsForFixturesAction } = await import("@/lib/actions/pools");

function fixtureRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    home_team_external_id: "10",
    home_team_name: "Home FC",
    home_team_logo_url: null,
    away_team_external_id: "20",
    away_team_name: "Away FC",
    away_team_logo_url: null,
    competition_type: "Cup",
    scheduled_start_utc: "2026-08-01T18:00:00.000Z",
    ...overrides,
  };
}

const BASE_INPUT = {
  poolType: "WHO_WILL_ADVANCE" as const,
  fixtureIds: ["3fa85f64-5717-4562-b3fc-2c963f66afa6", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
  entryFee: "5.00",
  houseFeePercent: "5",
  visibility: "VISIBLE_TO_ALL_MEMBERS",
  participationVisibility: "SHOW_BEFORE_ENTRY",
  lockMinutesBeforeKickoff: 10,
  publishImmediately: false,
};

beforeEach(() => {
  fixtureRows = [];
  poolInserts = [];
  optionInserts = [];
  poolIdCounter = 0;
});

describe("createPoolsForFixturesAction", () => {
  it("creates one pool per fixture, each with its own locks_at derived from its own kickoff", async () => {
    fixtureRows = [
      fixtureRow({ id: "3fa85f64-5717-4562-b3fc-2c963f66afa6", scheduled_start_utc: "2026-08-01T18:00:00.000Z" }),
      fixtureRow({ id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", scheduled_start_utc: "2026-08-02T12:00:00.000Z" }),
    ];

    const result = await createPoolsForFixturesAction(BASE_INPUT);

    expect(result.error).toBeNull();
    expect(result.results).toEqual([
      { fixtureId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", poolId: "pool-1", error: null },
      { fixtureId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", poolId: "pool-2", error: null },
    ]);
    expect(poolInserts).toHaveLength(2);
    expect(poolInserts[0].locks_at).toBe(new Date("2026-08-01T17:50:00.000Z").toISOString());
    expect(poolInserts[1].locks_at).toBe(new Date("2026-08-02T11:50:00.000Z").toISOString());
    expect(optionInserts).toHaveLength(2);
  });

  it("continues past one ineligible fixture and still creates pools for the rest", async () => {
    // WHO_WILL_ADVANCE requires a knockout (Cup) fixture — a League fixture
    // isn't eligible and must fail without blocking the Cup fixture.
    fixtureRows = [
      fixtureRow({ id: "3fa85f64-5717-4562-b3fc-2c963f66afa6", competition_type: "Cup" }),
      fixtureRow({ id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", competition_type: "League" }),
    ];

    const result = await createPoolsForFixturesAction(BASE_INPUT);

    expect(result.error).toBeNull();
    const fixture1 = result.results.find((r) => r.fixtureId === "3fa85f64-5717-4562-b3fc-2c963f66afa6");
    const fixture2 = result.results.find((r) => r.fixtureId === "6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    expect(fixture1?.poolId).toBe("pool-1");
    expect(fixture1?.error).toBeNull();
    expect(fixture2?.poolId).toBeNull();
    expect(fixture2?.error).toMatch(/isn't available/);
    expect(poolInserts).toHaveLength(1);
  });

  it("reports 'Fixture not found' for a fixture id the query doesn't return, without blocking the rest", async () => {
    // Only fixture-1 comes back — fixture-2 was deleted between selection
    // and submission, say.
    fixtureRows = [fixtureRow({ id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" })];

    const result = await createPoolsForFixturesAction(BASE_INPUT);

    expect(result.results).toEqual([
      { fixtureId: "3fa85f64-5717-4562-b3fc-2c963f66afa6", poolId: "pool-1", error: null },
      { fixtureId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8", poolId: null, error: "Fixture not found." },
    ]);
  });

  it("rejects a PLAYER_PROPS template — not portable across different fixtures", async () => {
    fixtureRows = [fixtureRow({ id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" }), fixtureRow({ id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" })];

    const result = await createPoolsForFixturesAction({
      ...BASE_INPUT,
      poolType: "TEMPLATE_GRADED",
      templateId: "PLAYER_TO_SCORE",
      templateConfig: { playerExternalId: "99", playerName: "Test Player" },
    });

    expect(result.error).toMatch(/Player prop templates/);
    expect(poolInserts).toHaveLength(0);
  });

  it("rejects an invalid entry fee without writing anything", async () => {
    const result = await createPoolsForFixturesAction({ ...BASE_INPUT, entryFee: "not-a-number" });

    expect(result.error).not.toBeNull();
    expect(result.results).toEqual([]);
    expect(poolInserts).toHaveLength(0);
  });

  it("rejects a lock lead time below the platform minimum without writing anything", async () => {
    const result = await createPoolsForFixturesAction({ ...BASE_INPUT, lockMinutesBeforeKickoff: 1 });

    expect(result.error).not.toBeNull();
    expect(poolInserts).toHaveLength(0);
  });

  it("creates a TEMPLATE_GRADED pool per fixture using a fixture-portable template", async () => {
    fixtureRows = [fixtureRow({ id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" }), fixtureRow({ id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" })];

    const result = await createPoolsForFixturesAction({
      ...BASE_INPUT,
      poolType: "TEMPLATE_GRADED",
      templateId: "MATCH_TOTAL_GOALS",
      templateConfig: { minimumGoals: 3 },
    });

    expect(result.error).toBeNull();
    expect(result.results.every((r) => r.poolId)).toBe(true);
    expect(poolInserts).toHaveLength(2);
    expect(poolInserts[0].template_id).toBe("MATCH_TOTAL_GOALS");
    expect(poolInserts[0].question).toBe("Will there be 3 or more goals?");
    // Stage 1: newly-created TEMPLATE_GRADED pools stamp the resolved
    // template version and opt into the balanced-participation check.
    expect(poolInserts[0].template_version).toBe(1);
    expect(poolInserts[0].participation_rule_version).toBe(2);
    expect(optionInserts[0]).toEqual([
      expect.objectContaining({ label: "Yes", binary_outcome: "YES" }),
      expect.objectContaining({ label: "No", binary_outcome: "NO" }),
    ]);
  });

  it("never stamps participation_rule_version for a legacy WHO_WILL_ADVANCE pool", async () => {
    fixtureRows = [fixtureRow({ id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" }), fixtureRow({ id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8" })];

    const result = await createPoolsForFixturesAction({
      ...BASE_INPUT,
      poolType: "WHO_WILL_ADVANCE",
    });

    expect(result.error).toBeNull();
    expect(poolInserts[0].template_version).toBeNull();
    expect(poolInserts[0].participation_rule_version).toBeNull();
    expect(optionInserts[0].every((o) => o.binary_outcome === null)).toBe(true);
  });
});
