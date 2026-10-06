/**
 * Admin Predictions search/filter: one bounded server-side query (real joins, literal matching), then the existing batched row loading.
 * Real local Supabase.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { seedGame, seedPick, setFixture } from "./helpers/game-seed";
import { listAdminPredictionRows, type AdminPredictionFilters } from "@/lib/predictions/admin-rows";

const admin = getTestAdminClient();
const tag = randomUUID().slice(0, 6);

async function member(username: string, displayName: string) {
  const { data, error } = await admin.auth.admin.createUser({ email: `${username}-${randomUUID()}@test.local`, password: "integration-test-password-123", email_confirm: true });
  if (error || !data.user) throw error ?? new Error("user");
  await admin.from("user_profiles").insert({ id: data.user.id, display_name: displayName, username, role: "player", is_active: true });
  return data.user.id;
}

const ids: Record<string, string> = {};
const picks: Record<string, string> = {};
const search = async (filters: AdminPredictionFilters) => listAdminPredictionRows(200, undefined, filters);

beforeAll(async () => {
  ids.carlos = await member(`carlos_${tag}`, `Carlos ${tag}`);
  ids.ana = await member(`ana_${tag}`, `Ana ${tag}`);
  ids.pct = await member(`pct${tag}100`, `Percent%Person ${tag}`);
  const g1 = await seedGame();
  const g2 = await seedGame();
  await admin.from("fixtures").update({ home_team_name: `Packers ${tag}`, away_team_name: `Falcons ${tag}` }).eq("id", g1.fixtureId);
  await admin.from("fixtures").update({ home_team_name: `Bears ${tag}`, away_team_name: `Jets ${tag}` }).eq("id", g2.fixtureId);
  ids.market1 = g1.marketId;
  ids.market2 = g2.marketId;
  picks.carlos1 = await seedPick(ids.carlos, g1.marketId, "YES");
  picks.ana1 = await seedPick(ids.ana, g1.marketId, "NO");
  picks.carlos2 = await seedPick(ids.carlos, g2.marketId, "NO");
  picks.pct2 = await seedPick(ids.pct, g2.marketId, "YES");
  // grade game 2: home (Bears) wins -> YES correct, NO incorrect
  await setFixture(g2.fixtureId, { internal_status: "COMPLETED", home_score: 20, away_score: 10 });
  await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "INCORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", picks.carlos2);
  await admin.from("predictions").update({ lifecycle_state: "GRADED", result: "CORRECT", resolved_outcome_snapshot: "YES", graded_at: new Date().toISOString() }).eq("id", picks.pct2);
});

const idsOf = (rows: Awaited<ReturnType<typeof search>>) => rows.map((r) => r.id).sort();

describe("search", () => {
  it("by username (substring, case-insensitive)", async () => {
    expect(idsOf(await search({ query: `CARLOS_${tag}` }))).toEqual([picks.carlos1, picks.carlos2].sort());
  });

  it("by display name", async () => {
    expect(idsOf(await search({ query: `Ana ${tag}` }))).toEqual([picks.ana1]);
  });

  it("by full user id, and by the short id the table shows (prefix)", async () => {
    expect(idsOf(await search({ query: ids.ana }))).toEqual([picks.ana1]);
    expect(idsOf(await search({ query: ids.ana.slice(0, 8) }))).toContain(picks.ana1);
  });

  it("by Market id (full and short), returning every Pick on that Market", async () => {
    expect(idsOf(await search({ query: ids.market1 }))).toEqual([picks.carlos1, picks.ana1].sort());
    expect(idsOf(await search({ query: ids.market2.slice(0, 8) }))).toEqual(expect.arrayContaining([picks.carlos2, picks.pct2]));
  });

  it("by team / match name — either team", async () => {
    expect(idsOf(await search({ query: `Packers ${tag}` }))).toEqual([picks.carlos1, picks.ana1].sort());
    expect(idsOf(await search({ query: `Jets ${tag}` }))).toEqual([picks.carlos2, picks.pct2].sort());
  });

  it("by Prediction id", async () => {
    expect(idsOf(await search({ query: picks.pct2 }))).toEqual([picks.pct2]);
  });

  it("matches % and _ literally, never as wildcards", async () => {
    expect(idsOf(await search({ query: `Percent%Person ${tag}` }))).toEqual([picks.pct2]);
    expect(idsOf(await search({ query: "%" })).includes(picks.ana1)).toBe(false); // a lone % is not "match everything"
    expect(idsOf(await search({ query: `Percent_Person ${tag}` }))).toEqual([]); // _ is not "any one character"
  });

  it("a quote / injection-looking query is just text and matches nothing", async () => {
    expect(await search({ query: "'; drop table predictions; --" })).toEqual([]);
  });
});

describe("filters", () => {
  it("state", async () => {
    expect(idsOf(await search({ query: tag, state: "GRADED" }))).toEqual([picks.carlos2, picks.pct2].sort());
    expect(idsOf(await search({ query: tag, state: "PENDING" }))).toEqual([picks.carlos1, picks.ana1].sort());
  });

  it("result, including 'not graded yet'", async () => {
    expect(idsOf(await search({ query: tag, result: "CORRECT" }))).toEqual([picks.pct2]);
    expect(idsOf(await search({ query: tag, result: "INCORRECT" }))).toEqual([picks.carlos2]);
    expect(idsOf(await search({ query: tag, result: "NONE" }))).toEqual([picks.carlos1, picks.ana1].sort());
  });

  it("date range is inclusive of both days (UTC)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect((await search({ query: tag, from: today, to: today })).length).toBe(4);
    expect(await search({ query: tag, to: yesterday })).toEqual([]);
    expect(await search({ query: tag, from: tomorrow })).toEqual([]);
  });

  it("filters combine (AND)", async () => {
    expect(idsOf(await search({ query: `carlos_${tag}`, state: "GRADED", result: "INCORRECT" }))).toEqual([picks.carlos2]);
    expect(await search({ query: `carlos_${tag}`, state: "GRADED", result: "CORRECT" })).toEqual([]);
  });
});

describe("rows and query model", () => {
  it("returns the same human-readable rows, with raw ids and the canonical selection still present, newest first", async () => {
    const rows = await search({ query: `carlos_${tag}` });
    expect(rows).toHaveLength(2);
    expect(rows[0].createdAt >= rows[1].createdAt).toBe(true);
    for (const row of rows) {
      expect(row.user).toMatchObject({ id: ids.carlos, shortId: ids.carlos.slice(0, 8), primary: `carlos_${tag}`, known: true });
      expect(["YES", "NO"]).toContain(row.selectedOutcome);
      expect(row.match.known).toBe(true);
      expect(row.market.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("is a bounded number of reads however many rows match — one search, then the batched loads (never one per row)", async () => {
    const reads: string[] = [];
    const rpcs: string[] = [];
    const counting = {
      from: (table: string) => {
        reads.push(table);
        return admin.from(table);
      },
      rpc: (name: string, args: Record<string, unknown>) => {
        rpcs.push(name);
        return admin.rpc(name, args);
      },
    };
    const rows = await listAdminPredictionRows(200, counting as never, { query: tag });
    expect(rows.length).toBe(4);
    expect(rpcs).toEqual(["admin_search_predictions"]);
    // predictions (ids), then profiles + markets in parallel, then fixtures: four table reads in total for any number of rows.
    expect(reads).toEqual(["predictions", "user_profiles", "markets", "fixtures"]);
  });

  it("respects the limit", async () => {
    expect((await listAdminPredictionRows(2, undefined, { query: tag })).length).toBe(2);
  });

  it("no filters = the unchanged most-recent view (no RPC involved)", async () => {
    const rpcs: string[] = [];
    const counting = { from: (t: string) => admin.from(t), rpc: (n: string, a: Record<string, unknown>) => (rpcs.push(n), admin.rpc(n, a)) };
    const rows = await listAdminPredictionRows(200, counting as never, {});
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rpcs).toEqual([]);
  });
});
