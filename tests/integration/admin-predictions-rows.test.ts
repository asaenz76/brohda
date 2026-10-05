/**
 * Integration coverage for /admin/predictions's data path against the real
 * local Supabase: usernames come from the user's profile, the Match from the
 * canonical fixture behind the Market, and an orphaned or profile-less row
 * degrades instead of failing. Also pins the batching: the number of table
 * reads is fixed (predictions, profiles, markets, fixtures) however many rows
 * there are — no per-row lookups.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";

vi.mock("server-only", () => ({}));

import { listAdminPredictionRows } from "@/lib/predictions/admin-rows";

const admin = getTestAdminClient();
const suffix = randomUUID().slice(0, 8);
const HOME = `Admin Home ${suffix}`;
const AWAY = `Admin Away ${suffix}`;
const QUESTION = `Will ${HOME} win?`;

const created = { users: [] as string[], fixtures: [] as string[], markets: [] as string[] };
let userWithProfile = "";
let userNoProfile = "";
let marketWithGame = "";
let marketSecond = "";

async function pick(userId: string, marketId: string, outcome: "YES" | "NO") {
  const { error } = await admin
    .rpc("set_pick", { p_user_id: userId, p_market_id: marketId, p_selected_outcome: outcome, p_yes_probability: 0.6, p_no_probability: 0.4, p_market_question: "q", p_market_close_at: null, p_market_status: "ACTIVE", p_idempotency_key: randomUUID() })
    .single();
  if (error) throw error;
}

beforeAll(async () => {
  const a = await admin.auth.admin.createUser({ email: `adm-a-${suffix}@test.local`, password: "integration-test-password-123", email_confirm: true });
  userWithProfile = a.data.user!.id;
  await admin.from("user_profiles").insert({ id: userWithProfile, display_name: `Display ${suffix}`, username: `adm${suffix}`, role: "player", is_active: true });
  const b = await admin.auth.admin.createUser({ email: `adm-b-${suffix}@test.local`, password: "integration-test-password-123", email_confirm: true });
  userNoProfile = b.data.user!.id;
  // predictions.user_id references the profile, so the realistic "no username" user is a profile with no username set.
  await admin.from("user_profiles").insert({ id: userNoProfile, display_name: `NoHandle ${suffix}`, username: null, role: "player", is_active: true });
  created.users.push(userWithProfile, userNoProfile);

  const { data: fixture } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `adm-${randomUUID()}`, sport: "american_football", home_team_name: HOME, away_team_name: AWAY, competition_name: "NFL", scheduled_start_utc: new Date(Date.now() + 48 * 3600_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  created.fixtures.push(fixture!.id);
  const marketBase = { provider: "adm", status: "ACTIVE", market_template: "MONEYLINE", yes_side: "HOME", yes_price: 0.6, no_price: 0.4, liquidity: 1000, last_synced_at: new Date().toISOString(), ingestion_source: "test", provider_metadata: {} };
  const { data: m1 } = await admin.from("markets").insert({ ...marketBase, provider_market_id: `adm_${randomUUID()}`, question: QUESTION, fixture_id: fixture!.id }).select("id").single();
  marketWithGame = m1!.id;
  created.markets.push(marketWithGame);
  // A second Market on a second Game, so the batch spans several Markets and Fixtures.
  const { data: fixture2 } = await admin
    .from("fixtures")
    .insert({ external_fixture_id: `adm-${randomUUID()}`, sport: "american_football", home_team_name: `${HOME} II`, away_team_name: `${AWAY} II`, competition_name: "NFL", scheduled_start_utc: new Date(Date.now() + 49 * 3600_000).toISOString(), internal_status: "NOT_STARTED" })
    .select("id")
    .single();
  created.fixtures.push(fixture2!.id);
  const { data: m2 } = await admin.from("markets").insert({ ...marketBase, provider_market_id: `adm_${randomUUID()}`, question: `Second market ${suffix}`, fixture_id: fixture2!.id }).select("id").single();
  marketSecond = m2!.id;
  created.markets.push(marketSecond);

  await pick(userWithProfile, marketWithGame, "YES");
  await pick(userNoProfile, marketWithGame, "NO");
  await pick(userWithProfile, marketSecond, "YES");
});

afterAll(async () => {
  await admin.from("predictions").delete().in("market_id", created.markets);
  await admin.from("markets").delete().in("id", created.markets);
  await admin.from("fixtures").delete().in("id", created.fixtures);
  for (const id of created.users) await admin.auth.admin.deleteUser(id);
});

const mine = async () => (await listAdminPredictionRows(500)).filter((r) => created.markets.includes(r.market.id));

describe("listAdminPredictionRows", () => {
  it("shows the username from the profile, the Match from the Market's canonical fixture, and the Market question — with raw ids intact", async () => {
    const row = (await mine()).find((r) => r.user.id === userWithProfile && r.market.id === marketWithGame)!;
    expect(row.user).toMatchObject({ primary: `adm${suffix}`, shortId: userWithProfile.slice(0, 8), id: userWithProfile, known: true });
    expect(row.match).toEqual({ primary: `${AWAY} @ ${HOME}`, known: true });
    expect(row.market).toMatchObject({ primary: QUESTION, shortId: marketWithGame.slice(0, 8), id: marketWithGame });
    expect(row.selectedOutcome).toBe("YES");
  });

  it("falls back to the display name for a user who never set a username (unknown-user / unknown-game / unknown-market fallbacks are covered by the unit tests)", async () => {
    const rows = await mine();
    const noHandle = rows.find((r) => r.user.id === userNoProfile)!;
    expect(noHandle.user).toMatchObject({ primary: `NoHandle ${suffix}`, shortId: userNoProfile.slice(0, 8), known: true });
    expect(noHandle.match.primary).toBe(`${AWAY} @ ${HOME}`);
    const second = rows.find((r) => r.market.id === marketSecond)!;
    expect(second.match).toEqual({ primary: `${AWAY} II @ ${HOME} II`, known: true });
    expect(second.market.primary).toBe(`Second market ${suffix}`);
  });

  it("resolves everything in batches — a bounded number of reads that grows with ids per chunk, never with rows (no N+1)", async () => {
    const reads: string[] = [];
    const counting = {
      from: (table: string) => {
        reads.push(table);
        return admin.from(table as never);
      },
    };
    const one = await listAdminPredictionRows(1, counting as never);
    expect(one).toHaveLength(1);
    expect(reads.length).toBeLessThanOrEqual(4); // predictions, profiles, markets, fixtures
    reads.length = 0;
    const many = await listAdminPredictionRows(500, counting as never);
    // One read of predictions, then at most one read per 150 distinct ids for each of the three lookups.
    const maxPerTable = Math.ceil(many.length / 150);
    expect(reads.length).toBeLessThanOrEqual(1 + 3 * maxPerTable);
    expect(reads.filter((t) => t === "predictions")).toHaveLength(1);
    // The real regression: hundreds of rows must not fail with "URI too long".
    expect(many.length).toBeGreaterThanOrEqual(one.length);
  });
});
