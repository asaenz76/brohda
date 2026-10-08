import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchInChunks } from "@/lib/utils/batch";
import type { CommunityType } from "./types";

// Phase D (Brohda 2.0 redesign) — the canonical "list Communities by
// type" query Phase A found missing (no such query existed anywhere in
// the codebase before this). A dedicated file, not an addition to
// repository.ts (that file is scoped to single/by-id Community identity
// and the ensure*Community writers) or feed.ts (scoped to Post-based
// feeds) — this is Discovery's own read layer, matching the established
// lib/prediction-markets/discovery/* pattern for a "discovery" concern
// getting its own directory-or-file boundary separate from the base
// repository.

export interface CommunityListItem {
  id: string;
  slug: string;
  type: CommunityType;
  displayName: string;
  /** From teams.logo_url / leagues.logo_url — always null for SPORT (no logo concept exists for it). Never a hard-coded URL. */
  logoUrl: string | null;
  /** SPORT Communities only (they have no crest): the sport key, so the UI can show the sport's own icon. Null for teams and leagues. */
  sportKey?: string | null;
  isFollowing: boolean;
  /**
   * Ordering signal ONLY — never rendered as a follower-count-style vanity
   * metric (spec §15: "avoid follower-count vanity unless there is a
   * clear product reason"; §11 forbids "comment velocity"/"secret
   * scoring"). The most recent canonical Post distributed to this
   * Community, or null if none yet.
   */
  mostRecentPostAt: string | null;
}

interface TeamRow {
  id: string;
  name: string;
  logo_url: string | null;
}
interface LeagueRow {
  id: string;
  name: string;
  logo_url: string | null;
}

/**
 * Batched display-name + logo resolution for TEAM/LEAGUE Communities in
 * one list — a Discovery-scoped sibling to
 * lib/communities/presentation.ts's single-Community getCommunityDisplayName
 * and lib/communities/feed.ts's own private resolveDisplayNames (which
 * only resolves names, not logos, for feed Community badges — a
 * different, smaller need). Two queries total regardless of list size:
 * one for team rows, one for league rows.
 */
async function resolveNamesAndLogos(
  admin: ReturnType<typeof createAdminClient>,
  rows: { id: string; type: CommunityType; team_id: string | null; league_id: string | null; display_name: string | null; sport_key: string | null }[],
): Promise<Map<string, { displayName: string; logoUrl: string | null }>> {
  const result = new Map<string, { displayName: string; logoUrl: string | null }>();

  const teamIds = rows.filter((r) => r.type === "TEAM" && r.team_id).map((r) => r.team_id as string);
  const leagueIds = rows.filter((r) => r.type === "LEAGUE" && r.league_id).map((r) => r.league_id as string);

  // Chunked: a list of a few hundred ids in one `.in()` makes the request URL too long ("URI too long") once a catalogue grows.
  const [teamRows, leagueRows] = await Promise.all([
    fetchInChunks<TeamRow>(teamIds, (chunk) => admin.from("teams").select("id, name, logo_url").in("id", chunk)),
    fetchInChunks<LeagueRow>(leagueIds, (chunk) => admin.from("leagues").select("id, name, logo_url").in("id", chunk)),
  ]);
  const teamById = new Map(teamRows.map((t) => [t.id, t]));
  const leagueById = new Map(leagueRows.map((l) => [l.id, l]));

  for (const row of rows) {
    if (row.type === "SPORT") {
      result.set(row.id, { displayName: row.display_name ?? row.sport_key ?? "Sport", logoUrl: null });
    } else if (row.type === "TEAM" && row.team_id) {
      const team = teamById.get(row.team_id);
      result.set(row.id, { displayName: team?.name ?? "Team", logoUrl: team?.logo_url ?? null });
    } else if (row.type === "LEAGUE" && row.league_id) {
      const league = leagueById.get(row.league_id);
      result.set(row.id, { displayName: league?.name ?? "League", logoUrl: league?.logo_url ?? null });
    }
  }
  return result;
}

/**
 * Ordering signal (spec §11 — "define exactly what activity means"):
 * the most recent post_communities.created_at per Community, batched
 * across the whole list in one query, tallied in memory (same pattern
 * lib/communities/feed.ts's listCommunitiesForPosts and
 * lib/post-comments/repository.ts's getPostCommentCountsForPosts already
 * use for this codebase's typical list sizes — a live read, not a
 * materialized ranking system, per spec §24's explicit preference).
 */
async function resolveMostRecentPostAt(admin: ReturnType<typeof createAdminClient>, communityIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (communityIds.length === 0) return result;
  const data = await fetchInChunks<{ community_id: string; created_at: string }>(communityIds, (chunk) => admin.from("post_communities").select("community_id, created_at").in("community_id", chunk));
  for (const row of data) {
    const current = result.get(row.community_id);
    if (!current || row.created_at > current) result.set(row.community_id, row.created_at);
  }
  return result;
}

/**
 * Ordering rule (spec §11, documented — no opaque ranking):
 *   1. Followed first.
 *   2. Then most recent relevant activity (most recent distributed Post),
 *      Communities with no activity yet sort after any with activity.
 *   3. Then alphabetical by display name — the deterministic canonical
 *      fallback, so two equally-followed/equally-inactive Communities
 *      never have an arbitrary order.
 * Pure, no I/O — unit-testable with explicit CommunityListItem values.
 */
export function compareCommunityListItems(a: CommunityListItem, b: CommunityListItem): number {
  if (a.isFollowing !== b.isFollowing) return a.isFollowing ? -1 : 1;

  const aTime = a.mostRecentPostAt ? new Date(a.mostRecentPostAt).getTime() : null;
  const bTime = b.mostRecentPostAt ? new Date(b.mostRecentPostAt).getTime() : null;
  if (aTime !== bTime) {
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return bTime - aTime;
  }

  return a.displayName.localeCompare(b.displayName);
}

/**
 * Every active Community of one type, with follow state and an ordering
 * signal, fully batched: Communities (1 query) + names/logos (≤2 queries)
 * + follow state (1 query, only if userId) + activity (1 query) — 4-5
 * queries total regardless of list size, never one per Community.
 *
 * `userId` null (no authenticated viewer) returns every item with
 * isFollowing: false rather than requiring a caller-side branch —
 * mirrors getSocialFeed()'s own optional-userId convention.
 */
export async function listCommunitiesByType(type: CommunityType, userId: string | null): Promise<CommunityListItem[]> {
  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("communities")
    .select("id, slug, type, team_id, league_id, sport_key, display_name")
    .eq("type", type)
    .eq("active", true);
  if (error) throw error;
  if (!rows || rows.length === 0) return [];

  const communityIds = rows.map((r) => r.id);

  const [namesAndLogos, followedIds, mostRecentPostAt] = await Promise.all([
    resolveNamesAndLogos(admin, rows),
    userId
      ? fetchInChunks<{ community_id: string }>(communityIds, (chunk) => admin.from("community_follows").select("community_id").eq("user_id", userId).in("community_id", chunk)).then((rows) => new Set(rows.map((f) => f.community_id)))
      : Promise.resolve(new Set<string>()),
    resolveMostRecentPostAt(admin, communityIds),
  ]);

  const items: CommunityListItem[] = rows.map((row) => {
    const resolved = namesAndLogos.get(row.id);
    return {
      id: row.id,
      slug: row.slug,
      type: row.type as CommunityType,
      displayName: resolved?.displayName ?? "Community",
      logoUrl: resolved?.logoUrl ?? null,
      sportKey: row.type === "SPORT" ? row.sport_key : null,
      isFollowing: followedIds.has(row.id),
      mostRecentPostAt: mostRecentPostAt.get(row.id) ?? null,
    };
  });

  items.sort(compareCommunityListItems);
  return items;
}
