import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { slugify } from "./slug";
import type { Community, CommunityType } from "./types";

// Milestone R4 — the sole query surface for `communities`, matching this
// codebase's established one-repository-per-table convention.

interface CommunityRow {
  id: string;
  type: CommunityType;
  team_id: string | null;
  league_id: string | null;
  sport_key: string | null;
  slug: string;
  display_name: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

function toRecord(row: CommunityRow): Community {
  return {
    id: row.id,
    type: row.type,
    teamId: row.team_id,
    leagueId: row.league_id,
    sportKey: row.sport_key,
    slug: row.slug,
    displayName: row.display_name,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type EnsureCommunityOutcome = "created" | "existing";

/**
 * Generates a unique slug, checking for a pre-existing collision first.
 * The narrow race window this leaves (two different, real sports subjects
 * independently colliding on the same generated slug at the same instant)
 * is a known, reported limitation — not engineered around — because the
 * concurrency guarantee this milestone actually requires (§18, tested) is
 * "two concurrent ensure calls for the SAME subject produce one Community",
 * which communities_subject_unique + the catch-23505 fallback below
 * guarantees regardless of what happens here.
 */
async function uniqueSlug(admin: ReturnType<typeof createAdminClient>, base: string): Promise<string> {
  let candidate = base;
  let suffix = 1;
  while (true) {
    const { data } = await admin.from("communities").select("id").eq("slug", candidate).maybeSingle();
    if (!data) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}

async function ensureCommunity(
  admin: ReturnType<typeof createAdminClient>,
  identity: { type: CommunityType; team_id?: string; league_id?: string; sport_key?: string },
  slugBase: string,
  displayName: string | null,
): Promise<{ id: string; outcome: EnsureCommunityOutcome }> {
  let query = admin.from("communities").select("id").eq("type", identity.type);
  if (identity.team_id) query = query.eq("team_id", identity.team_id);
  if (identity.league_id) query = query.eq("league_id", identity.league_id);
  if (identity.sport_key) query = query.eq("sport_key", identity.sport_key);
  const { data: existing } = await query.maybeSingle();
  if (existing) return { id: existing.id, outcome: "existing" };

  const slug = await uniqueSlug(admin, slugBase);
  const { data, error } = await admin
    .from("communities")
    .insert({ type: identity.type, team_id: identity.team_id ?? null, league_id: identity.league_id ?? null, sport_key: identity.sport_key ?? null, slug, display_name: displayName })
    .select("id")
    .single();
  if (!error) return { id: data.id, outcome: "created" };

  if (error.code === "23505") {
    let selectQuery = admin.from("communities").select("id").eq("type", identity.type);
    if (identity.team_id) selectQuery = selectQuery.eq("team_id", identity.team_id);
    if (identity.league_id) selectQuery = selectQuery.eq("league_id", identity.league_id);
    if (identity.sport_key) selectQuery = selectQuery.eq("sport_key", identity.sport_key);
    const { data: raceWinner, error: selectError } = await selectQuery.single();
    if (selectError || !raceWinner) throw selectError ?? error;
    return { id: raceWinner.id, outcome: "existing" };
  }

  throw error;
}

/** Idempotent get-or-create (§12, §17-18) for a TEAM Community. `teamId` must already exist in `teams`. */
export async function ensureTeamCommunity(teamId: string): Promise<{ id: string; outcome: EnsureCommunityOutcome }> {
  const admin = createAdminClient();
  const { data: team, error } = await admin.from("teams").select("name").eq("id", teamId).single();
  if (error || !team) throw error ?? new Error(`team ${teamId} not found`);
  return ensureCommunity(admin, { type: "TEAM", team_id: teamId }, slugify(team.name), null);
}

/** Idempotent get-or-create for a LEAGUE Community. `leagueId` must already exist in `leagues`. */
export async function ensureLeagueCommunity(leagueId: string): Promise<{ id: string; outcome: EnsureCommunityOutcome }> {
  const admin = createAdminClient();
  const { data: league, error } = await admin.from("leagues").select("name").eq("id", leagueId).single();
  if (error || !league) throw error ?? new Error(`league ${leagueId} not found`);
  return ensureCommunity(admin, { type: "LEAGUE", league_id: leagueId }, slugify(league.name), null);
}

/**
 * Idempotent get-or-create for a SPORT Community. Unlike TEAM/LEAGUE,
 * there is no canonical `sports` entity to resolve a name from — the
 * caller supplies `displayName` directly (see
 * lib/communities/distribution.ts's humanizeSportKey for how the one
 * caller derives it deterministically from the fixture's own `sport`
 * column, never a hard-coded label).
 */
export async function ensureSportCommunity(sportKey: string, displayName: string): Promise<{ id: string; outcome: EnsureCommunityOutcome }> {
  const admin = createAdminClient();
  return ensureCommunity(admin, { type: "SPORT", sport_key: sportKey }, slugify(sportKey), displayName);
}

export async function getCommunityBySlug(slug: string): Promise<Community | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("communities").select("*").eq("slug", slug).maybeSingle();
  if (error) throw error;
  return data ? toRecord(data as CommunityRow) : null;
}

export async function getCommunityById(id: string): Promise<Community | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.from("communities").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toRecord(data as CommunityRow) : null;
}

/** Stage 4A remediation (feed/Post Community badges): batched by id, one query regardless of count — avoids an N-query loop when a feed page needs several Posts' worth of Communities at once. */
export async function listCommunitiesByIds(ids: string[]): Promise<Community[]> {
  if (ids.length === 0) return [];
  const admin = createAdminClient();
  const { data, error } = await admin.from("communities").select("*").in("id", ids);
  if (error) throw error;
  return (data as CommunityRow[]).map(toRecord);
}
