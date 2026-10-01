"use server";

import { revalidatePath } from "next/cache";
import { requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";

export type DeleteFixtureResult = { success: boolean; error: string | null };

/**
 * Hard-deletes an imported fixture — only ever safe when no Post references
 * it (posts.fixture_id has no ON DELETE clause, so a referenced fixture
 * would fail the delete anyway; checked explicitly here for a clean error
 * message instead of a raw FK-violation). super_admin-only.
 */
export async function deleteFixtureAction(fixtureId: string): Promise<DeleteFixtureResult> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const { count } = await adminClient
    .from("posts")
    .select("id", { count: "exact", head: true })
    .eq("fixture_id", fixtureId);

  if (count && count > 0) {
    return { success: false, error: "This fixture has a Post attached — it can't be deleted." };
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
  return { success: true, error: null };
}
