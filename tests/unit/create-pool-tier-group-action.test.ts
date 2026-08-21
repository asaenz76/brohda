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
let poolIdCounter = 0;

// A minimal but real chainable/awaitable query-builder mock for the
// "pools" table's conflict-check query specifically
// (getActivePoolSummariesForFixture: select().eq().in()[.neq()][.or()]) —
// filters an in-memory snapshot of poolInserts the same way the real
// PostgREST filters would, so the tier-group exclusion logic is genuinely
// exercised rather than stubbed to always return [].
function poolsSelectBuilder() {
  let rows: Array<Record<string, unknown>> = poolInserts.map((p, i) => ({ id: `pool-${i + 1}`, ...p }));
  const builder = {
    eq: (col: string, val: unknown) => {
      rows = rows.filter((r) => r[col] === val);
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      rows = rows.filter((r) => vals.includes(r[col]));
      return builder;
    },
    neq: (col: string, val: unknown) => {
      rows = rows.filter((r) => r[col] !== val);
      return builder;
    },
    or: (expr: string) => {
      // Only the tier_group_id.is.null,tier_group_id.neq.<id> shape is
      // ever produced by getActivePoolSummariesForFixture.
      const excludeId = expr.split("tier_group_id.neq.")[1];
      rows = rows.filter((r) => r.tier_group_id == null || r.tier_group_id !== excludeId);
      return builder;
    },
    then: (resolve: (v: { data: typeof rows; error: null }) => void) => resolve({ data: rows, error: null }),
  };
  return builder;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "fixtures") {
        return { select: () => ({ eq: () => ({ single: async () => ({ data: fixtureRows[0] ?? null }) }) }) };
      }
      if (table === "pools") {
        return {
          select: () => poolsSelectBuilder(),
          insert: (payload: Record<string, unknown>) => {
            poolInserts.push(payload);
            const id = `pool-${++poolIdCounter}`;
            return { select: () => ({ single: async () => ({ data: { id }, error: null }) }) };
          },
        };
      }
      if (table === "pool_options") {
        return { insert: async () => ({ error: null }) };
      }
      throw new Error(`Unexpected table in test: ${table}`);
    },
  }),
}));

const { createPoolTierGroupAction } = await import("@/lib/actions/pools");

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
    sport: "football",
    scheduled_start_utc: "2026-08-01T18:00:00.000Z",
    ...overrides,
  };
}

const BASE_INPUT = {
  poolType: "WHO_WILL_ADVANCE" as const,
  fixtureId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  entryFees: ["5.00", "10.00", "25.00"],
  houseFeePercent: "5",
  visibility: "VISIBLE_TO_ALL_MEMBERS",
  participationVisibility: "SHOW_BEFORE_ENTRY",
  locksAt: "2026-08-01T17:50:00.000Z",
  publishImmediately: false,
};

beforeEach(() => {
  fixtureRows = [fixtureRow()];
  poolInserts = [];
  poolIdCounter = 0;
});

describe("createPoolTierGroupAction", () => {
  it("creates one pool per fee tier, all sharing one tier_group_id, none tripping EXACT_DUPLICATE against each other", async () => {
    const result = await createPoolTierGroupAction(BASE_INPUT);

    expect(result.error).toBeNull();
    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.poolId && r.error === null)).toBe(true);
    expect(poolInserts).toHaveLength(3);

    const groupIds = new Set(poolInserts.map((p) => p.tier_group_id));
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).toBeTruthy();

    expect(poolInserts.map((p) => p.entry_fee)).toEqual([500, 1000, 2500]);
    // house_fee_bps is shared, not per-tier.
    expect(poolInserts.every((p) => p.house_fee_bps === 500)).toBe(true);
  });

  it("rejects duplicate entry fee amounts without writing anything", async () => {
    const result = await createPoolTierGroupAction({ ...BASE_INPUT, entryFees: ["5.00", "5.00"] });

    expect(result.error).not.toBeNull();
    expect(result.results).toEqual([]);
    expect(poolInserts).toHaveLength(0);
  });

  it("rejects fewer than 2 tiers without writing anything", async () => {
    const result = await createPoolTierGroupAction({ ...BASE_INPUT, entryFees: ["5.00"] });

    expect(result.error).not.toBeNull();
    expect(poolInserts).toHaveLength(0);
  });

  it("rejects an invalid entry fee amount without writing anything", async () => {
    const result = await createPoolTierGroupAction({ ...BASE_INPUT, entryFees: ["5.00", "not-a-number"] });

    expect(result.error).not.toBeNull();
    expect(poolInserts).toHaveLength(0);
  });

  it("stops the whole batch if the first tier hits a real external duplicate (not overridden)", async () => {
    // A pre-existing, unrelated pool (no tier_group_id) with the exact same
    // poolType on this fixture — tier 1's conflict check must still see
    // this (only siblings sharing the new group get excluded).
    poolInserts = [
      {
        fixture_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        pool_type: "WHO_WILL_ADVANCE",
        template_id: null,
        template_config: null,
        tier_group_id: null,
        status: "OPEN",
      },
    ];

    const result = await createPoolTierGroupAction(BASE_INPUT);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].warnings?.length).toBeGreaterThan(0);
    expect(result.results[0].poolId).toBeNull();
    // No new pool rows written — only the pre-existing one from setup.
    expect(poolInserts).toHaveLength(1);
  });

  it("proceeds through every tier when overridePublishWarnings is set", async () => {
    poolInserts = [
      {
        fixture_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        pool_type: "WHO_WILL_ADVANCE",
        template_id: null,
        template_config: null,
        tier_group_id: null,
        status: "OPEN",
      },
    ];

    const result = await createPoolTierGroupAction({ ...BASE_INPUT, overridePublishWarnings: true });

    expect(result.results).toHaveLength(3);
    expect(result.results.every((r) => r.poolId)).toBe(true);
  });

  it("reports 'Fixture not found' and writes nothing when the fixture doesn't resolve", async () => {
    fixtureRows = [];

    const result = await createPoolTierGroupAction(BASE_INPUT);

    expect(result.error).toBe("Fixture not found.");
    expect(poolInserts).toHaveLength(0);
  });
});
