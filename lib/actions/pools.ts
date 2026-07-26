"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSuperAdmin, requireAdminOrAbove, requireUser } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { generatePoolTemplate, getTemplateEligibility, type PoolType } from "@/lib/pools/templates";
import { getTemplate, TEMPLATE_CONFIG_SCHEMAS } from "@/lib/pools/templates/registry";
import { resolvePoolAnalyticsCategory } from "@/lib/pools/templates/category-labels";
import { getPoolLiveStats, type PoolLiveStats } from "@/lib/pools/fetch";
import { notifyPoolPublished } from "@/lib/email/notify-pool-published";
import { parseDollarsToCents, parsePercentToBps } from "@/lib/utils/money";
import {
  createPoolFromTemplateSchema,
  updatePoolSchema,
  voidEntrySchema,
  MINIMUM_POOL_ENTRIES,
  MINIMUM_LOCK_LEAD_MINUTES,
} from "@/lib/validations/pools";

function readPoolConfigFromForm(formData: FormData) {
  return {
    entryFeeCents: parseDollarsToCents(String(formData.get("entryFee") ?? "")),
    houseFeeBps: parsePercentToBps(String(formData.get("houseFeePercent") ?? "0")),
    visibility: String(formData.get("visibility") ?? "VISIBLE_TO_ALL_MEMBERS"),
    participationVisibility: String(
      formData.get("participationVisibility") ?? "SHOW_BEFORE_ENTRY",
    ),
    locksAt: String(formData.get("locksAt") ?? ""),
  };
}

// Shared by createPoolFromTemplate and updatePoolAction — the only two
// places a human ever sets locks_at by hand. Not a DB constraint (see
// MINIMUM_LOCK_LEAD_MINUTES's own comment for why).
function isLockTooCloseToKickoff(locksAtIso: string, kickoffIso: string): boolean {
  const latestAllowed = new Date(kickoffIso).getTime() - MINIMUM_LOCK_LEAD_MINUTES * 60_000;
  return new Date(locksAtIso).getTime() > latestAllowed;
}

export type CreatePoolFromTemplateState = { error: string | null };

/**
 * The structured template builder's single entry point — every template
 * (REGULATION_RESULT, WHO_WILL_ADVANCE, COMBO) is fixture-backed, so this
 * always looks the fixture up first. CUSTOM (free-text, no fixture) pools
 * are no longer creatable here; existing CUSTOM pools already in the
 * database are untouched (grading/settlement/deletion all still work the
 * same, only this creation path changed).
 */
export async function createPoolFromTemplate(
  _prevState: CreatePoolFromTemplateState,
  formData: FormData,
): Promise<CreatePoolFromTemplateState> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const poolType = String(formData.get("poolType") ?? "");
  const sharedConfig = readPoolConfigFromForm(formData);

  let templateConfigRaw: unknown = undefined;
  if (poolType === "TEMPLATE_GRADED") {
    try {
      templateConfigRaw = JSON.parse(String(formData.get("templateConfig") ?? "{}"));
    } catch {
      return { error: "Check the pool configuration — something's missing or invalid." };
    }
  }

  const parsed =
    poolType === "COMBO"
      ? createPoolFromTemplateSchema.safeParse({
          poolType: "COMBO",
          fixtureId: formData.get("fixtureId"),
          title: formData.get("title"),
          question: formData.get("question"),
          legs: formData.getAll("legs"),
          ...sharedConfig,
        })
      : poolType === "TEMPLATE_GRADED"
        ? createPoolFromTemplateSchema.safeParse({
            poolType: "TEMPLATE_GRADED",
            fixtureId: formData.get("fixtureId"),
            templateId: formData.get("templateId"),
            templateConfig: templateConfigRaw,
            ...sharedConfig,
          })
        : createPoolFromTemplateSchema.safeParse({
            poolType,
            fixtureId: formData.get("fixtureId"),
            ...sharedConfig,
          });

  if (!parsed.success) {
    return { error: "Check the pool configuration — something's missing or invalid." };
  }

  // COMBO stays super_admin-only — a regular admin creating one would
  // produce a pool that only super_admin can ever grade (manual leg
  // grading, like every other money-adjacent action, stays super_admin-
  // only), which would leave it stuck ungraded until one is available.
  if (parsed.data.poolType === "COMBO" && admin.role !== "super_admin") {
    return { error: "Only super admins can create a combo poll." };
  }

  // The specific template's own schema validates templateConfig's exact
  // shape now that templateId is known — createPoolFromTemplateSchema only
  // checked it was a plain object.
  let selectedTemplate: ReturnType<typeof getTemplate> = null;
  if (parsed.data.poolType === "TEMPLATE_GRADED") {
    selectedTemplate = getTemplate(parsed.data.templateId);
    const configSchema = selectedTemplate ? TEMPLATE_CONFIG_SCHEMAS[selectedTemplate.id] : null;
    if (!selectedTemplate || !configSchema) {
      return { error: "Unknown template." };
    }
    const configParsed = configSchema.safeParse(parsed.data.templateConfig);
    if (!configParsed.success) {
      return { error: "Check the template configuration — something's missing or invalid." };
    }
    parsed.data.templateConfig = configParsed.data as Record<string, unknown>;
  }

  const { data: fixture } = await adminClient
    .from("fixtures")
    .select(
      "home_team_external_id, home_team_name, home_team_logo_url, away_team_external_id, away_team_name, away_team_logo_url, competition_type, scheduled_start_utc",
    )
    .eq("id", parsed.data.fixtureId)
    .single();

  if (!fixture) {
    return { error: "Fixture not found." };
  }

  if (isLockTooCloseToKickoff(parsed.data.locksAt, fixture.scheduled_start_utc)) {
    return {
      error: `Lock time must be at least ${MINIMUM_LOCK_LEAD_MINUTES} minutes before kickoff.`,
    };
  }

  // Re-checked here, not just in the client's disabled-card UI — a knockout
  // fixture (Cup) can never end in a draw, so "Result after regulation"
  // isn't a valid template for it, and vice versa for "Who will advance?"
  // on a League fixture.
  if (parsed.data.poolType === "WHO_WILL_ADVANCE" || parsed.data.poolType === "REGULATION_RESULT") {
    const eligibility = getTemplateEligibility(fixture.competition_type);
    if (parsed.data.poolType === "WHO_WILL_ADVANCE" && !eligibility.whoWillAdvanceEnabled) {
      return { error: "\"Who will advance?\" isn't available for this fixture — it isn't a knockout match." };
    }
    if (parsed.data.poolType === "REGULATION_RESULT" && !eligibility.regulationResultEnabled) {
      return {
        error:
          "\"Result after regulation\" isn't available for this fixture — it's a knockout match, so a draw isn't a possible final outcome.",
      };
    }
  }

  const templateFixtureScore = {
    homeTeamName: fixture.home_team_name,
    awayTeamName: fixture.away_team_name,
    homeTeamExternalId: fixture.home_team_external_id,
    awayTeamExternalId: fixture.away_team_external_id,
    regulationHomeScore: null,
    regulationAwayScore: null,
    halftimeHomeScore: null,
    halftimeAwayScore: null,
  };

  // Re-checked here, not just in the client's disabled-card UI — mirrors
  // the WHO_WILL_ADVANCE/REGULATION_RESULT eligibility re-check above.
  if (parsed.data.poolType === "TEMPLATE_GRADED" && selectedTemplate) {
    const availability = selectedTemplate.availabilityCheck(templateFixtureScore, {
      FIXTURE: true,
      FIXTURE_EVENTS: true,
      FIXTURE_STATISTICS: false,
      FIXTURE_PLAYERS: false,
      LINEUPS: false,
    });
    if (!availability.available) {
      return { error: availability.reason };
    }
  }

  let title: string | null = null;
  let question: string;
  let poolOptions: Array<{
    label: string;
    external_team_id: string | null;
    team_name: string | null;
    logo_url: string | null;
    sort_order: number;
  }>;
  let comboLegs: string[] | null = null;

  if (parsed.data.poolType === "COMBO") {
    title = parsed.data.title;
    question = parsed.data.question;
    // Fixed pair, not admin-input — the N leg conditions (below) are what
    // determine which of these two wins, not free-text choices.
    poolOptions = [
      { label: "Yes", external_team_id: null, team_name: null, logo_url: null, sort_order: 0 },
      { label: "No", external_team_id: null, team_name: null, logo_url: null, sort_order: 1 },
    ];
    comboLegs = parsed.data.legs;
  } else if (parsed.data.poolType === "TEMPLATE_GRADED" && selectedTemplate) {
    question = selectedTemplate.questionBuilder(templateFixtureScore, parsed.data.templateConfig);
    // Same fixed pair as COMBO — every Phase-1 template is binary YES/NO;
    // gradeTemplatePool looks these up by label ("Yes"/"No"), not by id.
    poolOptions = [
      { label: "Yes", external_team_id: null, team_name: null, logo_url: null, sort_order: 0 },
      { label: "No", external_team_id: null, team_name: null, logo_url: null, sort_order: 1 },
    ];
  } else {
    const template = generatePoolTemplate(parsed.data.poolType as PoolType, {
      homeTeamExternalId: fixture.home_team_external_id,
      homeTeamName: fixture.home_team_name,
      homeTeamLogoUrl: fixture.home_team_logo_url,
      awayTeamExternalId: fixture.away_team_external_id,
      awayTeamName: fixture.away_team_name,
      awayTeamLogoUrl: fixture.away_team_logo_url,
    });

    question = template.question;
    poolOptions = template.options.map((option) => ({
      label: option.label,
      external_team_id: option.externalTeamId,
      team_name: option.teamName,
      logo_url: option.logoUrl,
      sort_order: option.sortOrder,
    }));
  }

  // "Publish immediately" (spec's Step 4 Publish/Save Draft choice) skips
  // straight to OPEN instead of the usual DRAFT-then-separately-publish
  // gate — same status publishPoolAction would set, just done here so the
  // wizard's single submit can do it in one round trip.
  const publishImmediately = formData.get("publishImmediately") === "on";

  const { data: pool, error: poolError } = await adminClient
    .from("pools")
    .insert({
      fixture_id: parsed.data.fixtureId,
      created_by: admin.id,
      pool_type: parsed.data.poolType,
      template_id: parsed.data.poolType === "TEMPLATE_GRADED" ? parsed.data.templateId : null,
      template_config: parsed.data.poolType === "TEMPLATE_GRADED" ? parsed.data.templateConfig : null,
      analytics_category: resolvePoolAnalyticsCategory(
        parsed.data.poolType,
        parsed.data.poolType === "TEMPLATE_GRADED" ? parsed.data.templateId : null,
      ),
      title,
      question,
      entry_fee: parsed.data.entryFeeCents,
      house_fee_bps: parsed.data.houseFeeBps,
      min_total_entries: MINIMUM_POOL_ENTRIES,
      visibility: parsed.data.visibility,
      participation_visibility: parsed.data.participationVisibility,
      open_at: new Date().toISOString(),
      locks_at: parsed.data.locksAt,
      status: publishImmediately ? "OPEN" : "DRAFT",
    })
    .select("id")
    .single();

  if (poolError || !pool) {
    return { error: "Could not create the pool." };
  }

  const { error: optionsError } = await adminClient
    .from("pool_options")
    .insert(poolOptions.map((option) => ({ ...option, pool_id: pool.id })));

  if (optionsError) {
    return { error: "Could not create pool options." };
  }

  if (comboLegs) {
    const { error: legsError } = await adminClient
      .from("pool_combo_legs")
      .insert(comboLegs.map((label, i) => ({ pool_id: pool.id, label, sort_order: i })));

    if (legsError) {
      return { error: "Could not create combo conditions." };
    }
  }

  await writeAuditLog({
    actorId: admin.id,
    action: publishImmediately ? "pool.created_and_published" : "pool.created",
    entityType: "pool",
    entityId: pool.id,
    after: { question, poolType: parsed.data.poolType, status: publishImmediately ? "OPEN" : "DRAFT" },
  });

  revalidatePath("/admin/pools");
  if (publishImmediately) {
    revalidatePath("/feed");
    await notifyPoolPublished({
      id: pool.id as string,
      question,
      visibility: parsed.data.visibility,
    });
  }
  redirect(`/admin/pools/${pool.id}`);
}

export async function publishPoolAction(poolId: string) {
  const admin = await requireAdminOrAbove();
  const adminClient = createAdminClient();

  const { data: before } = await adminClient.from("pools").select("*").eq("id", poolId).single();

  const { error } = await adminClient
    .from("pools")
    .update({ status: "OPEN" })
    .eq("id", poolId)
    .eq("status", "DRAFT");

  if (error) {
    throw new Error("Could not publish this pool.");
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.published",
    entityType: "pool",
    entityId: poolId,
    before,
    after: { status: "OPEN" },
  });

  revalidatePath("/admin/pools");
  revalidatePath(`/admin/pools/${poolId}`);
  revalidatePath("/feed");

  if (before) {
    await notifyPoolPublished({
      id: poolId,
      question: before.question as string,
      visibility: before.visibility as string,
    });
  }
}

export type UpdatePoolState = { error: string | null };

export async function updatePoolAction(
  _prevState: UpdatePoolState,
  formData: FormData,
): Promise<UpdatePoolState> {
  const admin = await requireAdminOrAbove();
  const adminClient = createAdminClient();

  const parsed = updatePoolSchema.safeParse({
    poolId: formData.get("poolId"),
    ...readPoolConfigFromForm(formData),
  });

  if (!parsed.success) {
    return { error: "Check the pool configuration — something's missing or invalid." };
  }

  const { data: before } = await adminClient
    .from("pools")
    .select("*")
    .eq("id", parsed.data.poolId)
    .single();

  if (!before) {
    return { error: "Pool not found." };
  }

  // Entry fee and Platform fee stay editable even after entries exist
  // (beta testing needs the fee droppable to 0% mid-pool) — everything
  // else that touches the entry window or who can see what is frozen once
  // money is committed, matching the DB trigger's own remaining checks.
  if (
    before.first_entry_at &&
    (new Date(parsed.data.locksAt).getTime() !== new Date(before.locks_at).getTime() ||
      parsed.data.visibility !== before.visibility ||
      parsed.data.participationVisibility !== before.participation_visibility)
  ) {
    return {
      error: "This pool already has entries — only the entry fee and Platform fee can change.",
    };
  }

  if (before.fixture_id) {
    const { data: fixture } = await adminClient
      .from("fixtures")
      .select("scheduled_start_utc")
      .eq("id", before.fixture_id)
      .single();

    if (fixture && isLockTooCloseToKickoff(parsed.data.locksAt, fixture.scheduled_start_utc)) {
      return {
        error: `Lock time must be at least ${MINIMUM_LOCK_LEAD_MINUTES} minutes before kickoff.`,
      };
    }
  }

  const { error } = await adminClient
    .from("pools")
    .update({
      entry_fee: parsed.data.entryFeeCents,
      house_fee_bps: parsed.data.houseFeeBps,
      visibility: parsed.data.visibility,
      participation_visibility: parsed.data.participationVisibility,
      locks_at: parsed.data.locksAt,
    })
    .eq("id", parsed.data.poolId);

  if (error) {
    return { error: "Could not update this pool." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "pool.updated",
    entityType: "pool",
    entityId: parsed.data.poolId,
    before,
    after: parsed.data,
  });

  revalidatePath(`/admin/pools/${parsed.data.poolId}`);
  return { error: null };
}

export type VoidEntryState = { error: string | null };

export async function voidEntryAction(
  _prevState: VoidEntryState,
  formData: FormData,
): Promise<VoidEntryState> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const parsed = voidEntrySchema.safeParse({
    entryId: formData.get("entryId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey"),
  });

  if (!parsed.success) {
    return { error: "A reason is required." };
  }

  const { data: before } = await adminClient
    .from("entries")
    .select("*")
    .eq("id", parsed.data.entryId)
    .single();

  const { error } = await adminClient.rpc("void_pool_entry", {
    p_entry_id: parsed.data.entryId,
    p_admin_id: admin.id,
    p_reason: parsed.data.reason,
    p_idempotency_key: parsed.data.idempotencyKey,
  });

  if (error) {
    return { error: "Could not void this entry." };
  }

  await writeAuditLog({
    actorId: admin.id,
    action: "entry.voided",
    entityType: "entry",
    entityId: parsed.data.entryId,
    before,
    reason: parsed.data.reason,
  });

  if (before?.pool_id) {
    revalidatePath(`/admin/pools/${before.pool_id}`);
  }
  return { error: null };
}

/**
 * Called by `SocialPoolCard` after a realtime broadcast tells it someone
 * entered this pool — just needs a signed-in viewer, same as any other
 * pool read; `getPoolLiveStats` itself applies the real gating.
 */
export async function getPoolLiveStatsAction(poolId: string): Promise<PoolLiveStats | null> {
  await requireUser();
  return getPoolLiveStats(poolId);
}
