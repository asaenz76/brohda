"use server";

import { revalidatePath } from "next/cache";
import { requireAdminOrAbove, requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { apiFootballProvider } from "@/lib/sports-data/api-football-provider";
import { toFixtureRow, toLeagueRow, toTeamRows } from "@/lib/sports-data/persist";
import type { NormalizedFixture } from "@/lib/sports-data/types";
import {
  fixtureSearchSchema,
  importFixturesSchema,
  setFixturesHiddenSchema,
} from "@/lib/validations/fixtures";

// Deliberately not NormalizedFixture — that type's providerPayload holds
// the entire raw provider JSON response per fixture. useActionState binds
// the previous state into every subsequent form submission (it's sent back
// to the server as part of the action call, not just kept client-side), so
// holding the full payload for every search result here made a large
// league/season search exceed Next's 1MB Server Action body limit on the
// *next* submit. This trims each result down to only what the UI actually
// renders (FixtureResultRow/FixtureResultsList) and what import needs
// (just the id).
export type FixtureSearchResult = {
  externalFixtureId: string;
  homeTeamName: string;
  awayTeamName: string;
  competitionName: string | null;
  round: string | null;
  scheduledStartUtc: string;
};

export type FixtureSearchState = {
  error: string | null;
  providerDisabled: boolean;
  results: FixtureSearchResult[];
};

function toSearchResult(f: NormalizedFixture): FixtureSearchResult {
  return {
    externalFixtureId: f.externalFixtureId,
    homeTeamName: f.homeTeamName,
    awayTeamName: f.awayTeamName,
    competitionName: f.competitionName,
    round: f.round,
    scheduledStartUtc: f.scheduledStartUtc,
  };
}

export async function searchFixturesAction(
  _prevState: FixtureSearchState,
  formData: FormData,
): Promise<FixtureSearchState> {
  await requireAdminOrAbove();

  if (!apiFootballProvider.isEnabled()) {
    return { error: null, providerDisabled: true, results: [] };
  }

  const mode = formData.get("mode") === "by_id" ? "by_id" : "by_league";
  const parsed = fixtureSearchSchema.safeParse({
    mode,
    externalFixtureId: formData.get("externalFixtureId") || undefined,
    competitionExternalId: formData.get("competitionExternalId") || undefined,
    season: formData.get("season") || undefined,
    date: formData.get("date") || undefined,
  });

  if (!parsed.success) {
    return {
      error: "Enter a fixture ID, or a league and season.",
      providerDisabled: false,
      results: [],
    };
  }

  try {
    const results = await apiFootballProvider.searchFixtures({
      externalFixtureId: parsed.data.externalFixtureId,
      competitionExternalId: parsed.data.competitionExternalId,
      season: parsed.data.season,
      date: parsed.data.date,
    });
    return { error: null, providerDisabled: false, results: results.map(toSearchResult) };
  } catch {
    return {
      error: "Could not reach the sports data provider. Try again shortly.",
      providerDisabled: false,
      results: [],
    };
  }
}

export type ImportFixtureResult = { externalFixtureId: string; success: boolean; error: string | null };

async function importOneFixture(externalFixtureId: string, adminId: string): Promise<ImportFixtureResult> {
  const fixture = await apiFootballProvider.getFixtureById(externalFixtureId);
  if (!fixture) {
    return { externalFixtureId, success: false, error: "Could not find this fixture." };
  }

  // The fixture lookup above never returns league.type (only /leagues
  // does) — fetched separately here, once per import, so the pool-creation
  // template picker can stage-gate "Who will advance?" vs "Result after
  // regulation" (spec: a Cup fixture is knockout, never a draw).
  const competitionType = fixture.competitionExternalId
    ? await apiFootballProvider.getLeagueType(fixture.competitionExternalId)
    : null;

  const adminClient = createAdminClient();
  const { error } = await adminClient
    .from("fixtures")
    .upsert(toFixtureRow({ ...fixture, competitionType }), { onConflict: "provider,external_fixture_id" });

  if (error) {
    return { externalFixtureId, success: false, error: "Could not import this fixture." };
  }

  const teamRows = toTeamRows(fixture);
  if (teamRows.length > 0) {
    await adminClient.from("teams").upsert(teamRows, { onConflict: "provider,external_id" });
  }
  const leagueRow = toLeagueRow(fixture);
  if (leagueRow) {
    await adminClient.from("leagues").upsert(leagueRow, { onConflict: "provider,external_id" });
  }

  await writeAuditLog({
    actorId: adminId,
    action: "fixture.imported",
    entityType: "fixture",
    entityId: fixture.externalFixtureId,
    after: {
      competitionName: fixture.competitionName,
      homeTeamName: fixture.homeTeamName,
      awayTeamName: fixture.awayTeamName,
    },
  });

  return { externalFixtureId, success: true, error: null };
}

/**
 * Called directly from client components (not tied to a <form action>),
 * for both the single-row "Import" button and the bulk "Import selected"
 * toolbar — same code path either way, just a different-sized array.
 */
export async function importFixturesAction(fixtureIds: string[]): Promise<ImportFixtureResult[]> {
  const admin = await requireAdminOrAbove();

  const parsed = importFixturesSchema.safeParse(fixtureIds);
  if (!parsed.success) {
    return fixtureIds.map((id) => ({ externalFixtureId: id, success: false, error: "Invalid fixture ID." }));
  }

  if (!apiFootballProvider.isEnabled()) {
    return parsed.data.map((id) => ({
      externalFixtureId: id,
      success: false,
      error: "The sports data provider is not enabled.",
    }));
  }

  const results: ImportFixtureResult[] = [];
  for (const externalFixtureId of parsed.data) {
    results.push(await importOneFixture(externalFixtureId, admin.id));
  }

  revalidatePath("/admin/fixtures");
  return results;
}

export type DeleteFixtureResult = { success: boolean; error: string | null };

/**
 * Hard-deletes an imported fixture — only ever safe when no pool references
 * it (pools.fixture_id has no ON DELETE clause, so a referenced fixture
 * would fail the delete anyway; checked explicitly here for a clean error
 * message instead of a raw FK-violation). super_admin-only, matching every
 * other hard-delete/destructive pool-lifecycle action (Cancel Pool, Grade
 * Manually, Void Entry, Delete Pool).
 */
export async function deleteFixtureAction(fixtureId: string): Promise<DeleteFixtureResult> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const { count } = await adminClient
    .from("pools")
    .select("id", { count: "exact", head: true })
    .eq("fixture_id", fixtureId);

  if (count && count > 0) {
    return { success: false, error: "This fixture has pools attached — it can't be deleted." };
  }

  const { data: fixture, error: deleteError } = await adminClient
    .from("fixtures")
    .delete()
    .eq("id", fixtureId)
    .select("external_fixture_id, home_team_name, away_team_name")
    .single();

  if (deleteError || !fixture) {
    return { success: false, error: "Could not delete this fixture." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "fixture.deleted",
    entityType: "fixture",
    entityId: fixture.external_fixture_id,
    before: { homeTeamName: fixture.home_team_name, awayTeamName: fixture.away_team_name },
  });

  revalidatePath("/admin/fixtures");
  revalidatePath("/admin/pools/new");
  return { success: true, error: null };
}

export type SetFixturesHiddenResult = { success: boolean; error: string | null; count: number };

/**
 * Hides/unhides a batch of fixtures from the "Create a pool" dropdown
 * (fixtures_available_for_pool_creation). Doesn't touch the fixture row
 * otherwise — it stays in the "Imported fixtures" list as a record, and any
 * pools already attached to it are unaffected.
 */
export async function setFixturesHiddenAction(
  fixtureIds: string[],
  hidden: boolean,
): Promise<SetFixturesHiddenResult> {
  const admin = await requireAdminOrAbove();

  const parsed = setFixturesHiddenSchema.safeParse(fixtureIds);
  if (!parsed.success) {
    return { success: false, error: "Invalid fixture selection.", count: 0 };
  }

  const adminClient = createAdminClient();
  const { data, error } = await adminClient
    .from("fixtures")
    .update({ hidden_from_pool_creation: hidden })
    .in("id", parsed.data)
    .select("id");

  if (error) {
    return { success: false, error: "Could not update these fixtures.", count: 0 };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: hidden ? "fixture.hidden_from_pool_creation" : "fixture.unhidden_from_pool_creation",
    entityType: "fixture",
    entityId: null,
    after: { fixtureIds: parsed.data },
  });

  revalidatePath("/admin/fixtures");
  revalidatePath("/admin/pools/new");
  return { success: true, error: null, count: data?.length ?? 0 };
}
