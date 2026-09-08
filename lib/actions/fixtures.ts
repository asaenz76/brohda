"use server";

import { revalidatePath } from "next/cache";
import { requireAdminOrAbove, requireSuperAdmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { setFixturesHiddenSchema } from "@/lib/validations/fixtures";

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
