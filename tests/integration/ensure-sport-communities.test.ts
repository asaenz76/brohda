/**
 * An active sport's Communities exist as soon as its Teams and League are synced — before any Game Post — so members can find and follow every team.
 * Real local database; the sport's teams here are seeded under the NHL's provider identity.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getTestAdminClient } from "./helpers/test-env";
import { ensureCommunitiesForActiveSports } from "@/lib/communities/distribution";

const admin = getTestAdminClient();
const ON = { teamEnabled: true, leagueEnabled: true, sportEnabled: true };

async function seed(n: number) {
  const suffix = randomUUID().slice(0, 8);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const { data } = await admin.from("teams").insert({ provider: "api_nhl", external_id: `ens-${suffix}-${i}`, name: `Ensure Team ${suffix} ${i}`, logo_url: "https://example.test/x.png" }).select("id").single();
    ids.push(data!.id);
  }
  return ids;
}
const teamCommunities = async (ids: string[]) => (await admin.from("communities").select("id, team_id").eq("type", "TEAM").in("team_id", ids)).data ?? [];

describe("ensureCommunitiesForActiveSports", () => {
  it("creates exactly one TEAM Community per synced team of an ACTIVE sport, once, and is idempotent", async () => {
    const ids = await seed(3);
    expect(await teamCommunities(ids)).toHaveLength(0);
    const first = await ensureCommunitiesForActiveSports(ON, { API_NHL_ENABLED: "true" });
    expect(first).toBeGreaterThanOrEqual(3);
    const after = await teamCommunities(ids);
    expect(after).toHaveLength(3);
    expect(new Set(after.map((c) => c.team_id)).size).toBe(3);
    expect(await ensureCommunitiesForActiveSports(ON, { API_NHL_ENABLED: "true" })).toBe(0);
    expect(await teamCommunities(ids)).toHaveLength(3);
  });

  it("an INACTIVE sport's teams are left alone (activation is configuration)", async () => {
    const ids = await seed(2);
    await ensureCommunitiesForActiveSports(ON, { API_NFL_ENABLED: "true" }); // NHL not active
    expect(await teamCommunities(ids)).toHaveLength(0);
  });

  it("honours the distribution policy flags: with team distribution off, no team Community is created", async () => {
    const ids = await seed(2);
    await ensureCommunitiesForActiveSports({ ...ON, teamEnabled: false }, { API_NHL_ENABLED: "true" });
    expect(await teamCommunities(ids)).toHaveLength(0);
  });

  it("also ensures the sport Community, once, with the registry's label", async () => {
    await ensureCommunitiesForActiveSports(ON, { API_NHL_ENABLED: "true" });
    const { data } = await admin.from("communities").select("display_name").eq("type", "SPORT").eq("sport_key", "hockey");
    expect(data).toEqual([{ display_name: "Hockey" }]);
  });
});
