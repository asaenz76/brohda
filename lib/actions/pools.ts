"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSuperAdmin, requireAdminOrAbove, requireUser } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit/log";
import { generatePoolTemplate, getTemplateEligibility, type PoolType } from "@/lib/pools/templates";
import { getLatestTemplate, getTemplateConfigSchema } from "@/lib/pools/templates/registry";
import { resolvePoolAnalyticsCategory } from "@/lib/pools/templates/category-labels";
import { getActivePoolSummariesForFixture } from "@/lib/pools/templates/active-pools";
import {
  detectConflicts,
  estimateYesProbabilityWithSource,
  rankRecommendations,
  toSerializableRecommendation,
  type PublishWarning,
} from "@/lib/pools/templates/recommendations";
import { getFixtureMarketsAction } from "@/lib/actions/odds";
import { getPoolLiveStats, type PoolLiveStats } from "@/lib/pools/fetch";
import { notifyFollowedPoolPublished } from "@/lib/email/notify-followed-pool-published";
import { getPoolPublishFollowRecipients } from "@/lib/pools/follow-recipients";
import { createPoolPublishedFollowNotifications } from "@/lib/notifications/create";
import { parseDollarsToCents, parsePercentToBps } from "@/lib/utils/money";
import {
  createPoolFromTemplateSchema,
  createPoolsForFixturesSchema,
  updatePoolSchema,
  voidEntrySchema,
  MINIMUM_POOL_ENTRIES,
  MINIMUM_LOCK_LEAD_MINUTES,
} from "@/lib/validations/pools";
import type { UserProfile } from "@/lib/auth/session";

function readPoolConfigFromForm(formData: FormData) {
  return {
    entryFeeCents: parseDollarsToCents(String(formData.get("entryFee") ?? "")),
    houseFeeBps: parsePercentToBps(String(formData.get("houseFeePercent") ?? "0")),
    visibility: String(formData.get("visibility") ?? "VISIBLE_TO_ALL_MEMBERS"),
    participationVisibility: String(
      formData.get("participationVisibility") ?? "SHOW_BEFORE_ENTRY",
    ),
    locksAt: String(formData.get("locksAt") ?? ""),
    overridePublishWarnings: formData.get("overridePublishWarnings") === "on",
  };
}

// Shared by createPoolFromTemplate and updatePoolAction — the only two
// places a human ever sets locks_at by hand. Not a DB constraint (see
// MINIMUM_LOCK_LEAD_MINUTES's own comment for why).
function isLockTooCloseToKickoff(locksAtIso: string, kickoffIso: string): boolean {
  const latestAllowed = new Date(kickoffIso).getTime() - MINIMUM_LOCK_LEAD_MINUTES * 60_000;
  return new Date(locksAtIso).getTime() > latestAllowed;
}

// Shared by both places a pool transitions DRAFT -> OPEN (create-and-publish
// and the explicit publish action) so the visibility guard and recipient
// resolution exist in exactly one place. Skips HIDDEN (link-only) pools
// entirely — in-app included, not just email — since blasting notifications
// about an invite-only pool to arbitrary team/league followers who weren't
// invited would defeat the point of hiding it (same reasoning the old
// blanket email flow used).
async function notifyFollowersOfPublish(pool: { id: string; question: string; fixtureId: string | null; visibility: string }) {
  if (pool.visibility !== "VISIBLE_TO_ALL_MEMBERS") return;

  const recipients = await getPoolPublishFollowRecipients(pool.fixtureId);
  if (recipients.length === 0) return;

  await createPoolPublishedFollowNotifications({
    poolId: pool.id,
    question: pool.question,
    recipientUserIds: recipients.map((r) => r.userId),
  });

  const emailUserIds = recipients.filter((r) => r.emailEnabled).map((r) => r.userId);
  await notifyFollowedPoolPublished({ pool: { id: pool.id, question: pool.question }, emailUserIds });
}

/**
 * Everything the wizard needs to render "Recommended Questions" and to
 * live-preview publish warnings as an admin picks/configures a template —
 * called once a fixture is selected. Read-only; never touches pools.
 */
export async function getFixtureQuestionContextAction(fixtureId: string, externalFixtureId: string | null = null) {
  await requireAdminOrAbove();
  const adminClient = createAdminClient();
  const [activePools, markets] = await Promise.all([
    getActivePoolSummariesForFixture(adminClient, fixtureId),
    // Real odds are optional, best-effort — a fixture with the provider
    // disabled, no odds posted yet, or a fetch failure still gets a full
    // recommendation list, just on the static prior (rankRecommendations
    // treats null exactly like "no markets fetched").
    externalFixtureId ? getFixtureMarketsAction(externalFixtureId) : Promise.resolve(null),
  ]);
  const recommendations = rankRecommendations(activePools, markets);
  return {
    activePools,
    recommendations: {
      recommended: recommendations.recommended.map(toSerializableRecommendation),
      other: recommendations.other.map(toSerializableRecommendation),
    },
  };
}

export type CreatePoolFromTemplateState = { error: string | null; warnings?: PublishWarning[] };

const FIXTURE_SELECT_FOR_POOL_CREATION =
  "id, external_fixture_id, home_team_external_id, home_team_name, home_team_logo_url, away_team_external_id, away_team_name, away_team_logo_url, competition_type, scheduled_start_utc";

type PoolFixtureRow = {
  id: string;
  external_fixture_id: string | null;
  home_team_external_id: string | null;
  home_team_name: string;
  home_team_logo_url: string | null;
  away_team_external_id: string | null;
  away_team_name: string;
  away_team_logo_url: string | null;
  competition_type: string | null;
  scheduled_start_utc: string;
};

// The fixture-independent part of a pool's configuration — shared by the
// single-fixture wizard and the multi-fixture bulk action, which both
// resolve their own fixtureId(s)/locksAt separately before calling
// createPoolForFixture per fixture.
type PoolCreationInput =
  | {
      poolType: "WHO_WILL_ADVANCE" | "REGULATION_RESULT";
      entryFeeCents: number;
      houseFeeBps: number;
      visibility: string;
      participationVisibility: string;
      overridePublishWarnings?: boolean;
    }
  | {
      poolType: "COMBO";
      title: string;
      question: string;
      legs: string[];
      entryFeeCents: number;
      houseFeeBps: number;
      visibility: string;
      participationVisibility: string;
      overridePublishWarnings?: boolean;
    }
  | {
      poolType: "TEMPLATE_GRADED";
      templateId: string;
      templateConfig: Record<string, unknown>;
      entryFeeCents: number;
      houseFeeBps: number;
      visibility: string;
      participationVisibility: string;
      overridePublishWarnings?: boolean;
    };

type CreatedPool = { id: string; question: string; fixtureId: string; visibility: string };

/**
 * The actual pool + pool_options (+ pool_combo_legs) insert for one fixture
 * — shared by the single-fixture wizard (createPoolFromTemplate) and the
 * multi-fixture bulk action (createPoolsForFixturesAction), so a template
 * applied across N fixtures goes through the exact same eligibility-check/
 * question-derivation/insert logic N times, once per fixture (each pool's
 * question/options always come from that fixture's own team names, not
 * whatever was cached client-side). Never throws — every failure path
 * returns { error } so a bulk caller's loop can't be aborted by one bad
 * fixture.
 */
async function createPoolForFixture(
  adminClient: ReturnType<typeof createAdminClient>,
  admin: UserProfile,
  input: PoolCreationInput,
  fixture: PoolFixtureRow,
  locksAt: string,
  publishImmediately: boolean,
): Promise<{ pool: CreatedPool } | { error: string } | { warnings: PublishWarning[] }> {
  if (isLockTooCloseToKickoff(locksAt, fixture.scheduled_start_utc)) {
    return {
      error: `Lock time must be at least ${MINIMUM_LOCK_LEAD_MINUTES} minutes before kickoff.`,
    };
  }

  // Re-checked here, not just in the client's disabled-card UI — a knockout
  // fixture (Cup) can never end in a draw, so "Result after regulation"
  // isn't a valid template for it, and vice versa for "Who will advance?"
  // on a League fixture.
  if (input.poolType === "WHO_WILL_ADVANCE" || input.poolType === "REGULATION_RESULT") {
    const eligibility = getTemplateEligibility(fixture.competition_type);
    if (input.poolType === "WHO_WILL_ADVANCE" && !eligibility.whoWillAdvanceEnabled) {
      return { error: "\"Who will advance?\" isn't available for this fixture — it isn't a knockout match." };
    }
    if (input.poolType === "REGULATION_RESULT" && !eligibility.regulationResultEnabled) {
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

  let selectedTemplate: ReturnType<typeof getLatestTemplate> = null;
  if (input.poolType === "TEMPLATE_GRADED") {
    selectedTemplate = getLatestTemplate(input.templateId);
    if (!selectedTemplate) {
      return { error: "Unknown template." };
    }
    // Re-checked here, not just in the client's disabled-card UI — mirrors
    // the WHO_WILL_ADVANCE/REGULATION_RESULT eligibility re-check above.
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

  // Real fixture odds, fetched once (through the 5-minute cache — see
  // lib/actions/odds.ts) and reused for both the publishing-guidance
  // probability below and the recommendation_evidence snapshot stamped on
  // the pool at insert time, so the two always agree with each other.
  // Never fetched for non-TEMPLATE_GRADED pools (WHO_WILL_ADVANCE/
  // REGULATION_RESULT/COMBO have no single well-defined YES probability).
  const markets =
    input.poolType === "TEMPLATE_GRADED" && fixture.external_fixture_id
      ? await getFixtureMarketsAction(fixture.external_fixture_id)
      : null;

  // Publishing guidance (Question Family/mirror/duplicate detection) — never
  // a hard block. COMBO is exempt: its identity is its legs (pool_combo_legs),
  // not template_id/template_config, so comparing empty configs between two
  // combos would misfire as an always-exact-duplicate. Every other pool type
  // (including legacy WHO_WILL_ADVANCE/REGULATION_RESULT) is checked, since
  // catching exactly that overlap against registry TEMPLATE_GRADED questions
  // is the whole point of this feature.
  let probabilityEstimate: ReturnType<typeof estimateYesProbabilityWithSource> | null = null;
  if (input.poolType !== "COMBO") {
    const candidateId = input.poolType === "TEMPLATE_GRADED" ? input.templateId : input.poolType;
    const candidateConfig = input.poolType === "TEMPLATE_GRADED" ? input.templateConfig : {};
    const activePools = await getActivePoolSummariesForFixture(adminClient, fixture.id);
    probabilityEstimate =
      input.poolType === "TEMPLATE_GRADED"
        ? estimateYesProbabilityWithSource(candidateId, candidateConfig, markets)
        : null;
    const yesProbability = probabilityEstimate?.probability ?? 0.5;
    const warnings = detectConflicts({ templateId: candidateId, config: candidateConfig }, activePools, yesProbability);

    if (warnings.length > 0 && !input.overridePublishWarnings) {
      return { warnings };
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
    binary_outcome: "YES" | "NO" | null;
  }>;
  let comboLegs: string[] | null = null;

  if (input.poolType === "COMBO") {
    title = input.title;
    question = input.question;
    // Fixed pair, not admin-input — the N leg conditions (below) are what
    // determine which of these two wins, not free-text choices.
    poolOptions = [
      { label: "Yes", external_team_id: null, team_name: null, logo_url: null, sort_order: 0, binary_outcome: "YES" },
      { label: "No", external_team_id: null, team_name: null, logo_url: null, sort_order: 1, binary_outcome: "NO" },
    ];
    comboLegs = input.legs;
  } else if (input.poolType === "TEMPLATE_GRADED" && selectedTemplate) {
    question = selectedTemplate.questionBuilder(templateFixtureScore, input.templateConfig);
    // Same fixed pair as COMBO — every Phase-1 template is binary YES/NO.
    // gradeTemplatePool resolves the winner from binary_outcome now, with
    // label matching kept only as a fallback for legacy rows.
    poolOptions = [
      { label: "Yes", external_team_id: null, team_name: null, logo_url: null, sort_order: 0, binary_outcome: "YES" },
      { label: "No", external_team_id: null, team_name: null, logo_url: null, sort_order: 1, binary_outcome: "NO" },
    ];
  } else {
    const template = generatePoolTemplate(input.poolType as PoolType, {
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
      binary_outcome: null,
    }));
  }

  const { data: pool, error: poolError } = await adminClient
    .from("pools")
    .insert({
      fixture_id: fixture.id,
      created_by: admin.id,
      pool_type: input.poolType,
      template_id: input.poolType === "TEMPLATE_GRADED" ? input.templateId : null,
      template_config: input.poolType === "TEMPLATE_GRADED" ? input.templateConfig : null,
      // Snapshotted so grading always resolves the exact version this pool
      // was created against (see getTemplate(id, version) in grade.ts).
      // Never stamped for COMBO — its options are a fixed Yes/No pair with
      // no registry template behind them at all.
      template_version: input.poolType === "TEMPLATE_GRADED" && selectedTemplate ? selectedTemplate.version : null,
      // 2 = new balanced-participation check at lock time (see
      // advance_or_cancel_locked_pool). Only ever stamped for newly-created
      // TEMPLATE_GRADED pools — COMBO keeps its current (legacy) behavior.
      participation_rule_version: input.poolType === "TEMPLATE_GRADED" ? 2 : null,
      // Informational snapshot of whatever produced this pool's estimated
      // probability at creation time (real bookmaker consensus, a single
      // book, or the static prior) — frozen from this point on by the
      // enforce_pool_fee_immutability trigger. Explicitly NOT settlement
      // evidence (see pool_grading_evidence for that): grading never reads
      // this column. Recommendations may change freely before this insert
      // runs; nothing about this snapshot ever changes after.
      recommendation_evidence: probabilityEstimate
        ? {
            source: probabilityEstimate.source,
            probability: probabilityEstimate.probability,
            bookmakerCount: probabilityEstimate.bookmakerCount,
            bookmakerIds: probabilityEstimate.bookmakerIds,
            marketKey: probabilityEstimate.marketKey,
            oddsLine: probabilityEstimate.oddsLine,
            oddsUpdatedAt: probabilityEstimate.source === "STATIC_PRIOR" ? null : (markets?.providerUpdatedAt ?? null),
          }
        : null,
      analytics_category: resolvePoolAnalyticsCategory(
        input.poolType,
        input.poolType === "TEMPLATE_GRADED" ? input.templateId : null,
      ),
      title,
      question,
      entry_fee: input.entryFeeCents,
      house_fee_bps: input.houseFeeBps,
      min_total_entries: MINIMUM_POOL_ENTRIES,
      visibility: input.visibility,
      participation_visibility: input.participationVisibility,
      open_at: new Date().toISOString(),
      locks_at: locksAt,
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
    entityId: pool.id as string,
    after: { question, poolType: input.poolType, status: publishImmediately ? "OPEN" : "DRAFT" },
  });

  return {
    pool: { id: pool.id as string, question, fixtureId: fixture.id, visibility: input.visibility },
  };
}

/**
 * The structured template builder's single-fixture entry point — every
 * template (REGULATION_RESULT, WHO_WILL_ADVANCE, COMBO) is fixture-backed,
 * so this always looks the fixture up first. CUSTOM (free-text, no
 * fixture) pools are no longer creatable here; existing CUSTOM pools
 * already in the database are untouched (grading/settlement/deletion all
 * still work the same, only this creation path changed).
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
  if (parsed.data.poolType === "TEMPLATE_GRADED") {
    const selectedTemplate = getLatestTemplate(parsed.data.templateId);
    const configSchema = selectedTemplate
      ? getTemplateConfigSchema(selectedTemplate.id, selectedTemplate.version)
      : null;
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
    .select(FIXTURE_SELECT_FOR_POOL_CREATION)
    .eq("id", parsed.data.fixtureId)
    .single();

  if (!fixture) {
    return { error: "Fixture not found." };
  }

  // "Publish immediately" (spec's Step 4 Publish/Save Draft choice) skips
  // straight to OPEN instead of the usual DRAFT-then-separately-publish
  // gate — same status publishPoolAction would set, just done here so the
  // wizard's single submit can do it in one round trip.
  const publishImmediately = formData.get("publishImmediately") === "on";

  const outcome = await createPoolForFixture(
    adminClient,
    admin,
    parsed.data as PoolCreationInput,
    fixture as PoolFixtureRow,
    parsed.data.locksAt,
    publishImmediately,
  );

  if ("warnings" in outcome) {
    return { error: null, warnings: outcome.warnings };
  }
  if ("error" in outcome) {
    return { error: outcome.error };
  }

  revalidatePath("/admin/pools");
  if (publishImmediately) {
    revalidatePath("/feed");
    await notifyFollowersOfPublish(outcome.pool);
  }
  redirect(`/admin/pools/${outcome.pool.id}`);
}

export type CreatePoolsForFixturesResult = {
  fixtureId: string;
  poolId: string | null;
  error: string | null;
  warnings?: PublishWarning[];
};

export type CreatePoolsForFixturesActionInput = {
  poolType: "WHO_WILL_ADVANCE" | "REGULATION_RESULT" | "TEMPLATE_GRADED";
  fixtureIds: string[];
  entryFee: string;
  houseFeePercent: string;
  visibility: string;
  participationVisibility: string;
  lockMinutesBeforeKickoff: number;
  templateId?: string;
  templateConfig?: Record<string, unknown>;
  publishImmediately: boolean;
  /** Fixtures already flagged with warnings on a first pass, re-submitted
   * with the admin's explicit go-ahead — see checkFixtureConflictsAction. */
  overridePublishWarnings?: boolean;
};

/**
 * The "multiple fixtures" wizard mode's entry point — applies one template
 * across every selected fixture, one pool per fixture. Called directly from
 * the client (not a <form action>, since there's no single redirect target
 * once N pools might be created) via useTransition, mirroring
 * importFixturesAction's shape (lib/actions/fixtures.ts): validate once,
 * then loop sequentially, never letting one fixture's failure (already
 * locked, ineligible template, etc.) abort the rest.
 */
export async function createPoolsForFixturesAction(
  input: CreatePoolsForFixturesActionInput,
): Promise<{ error: string | null; results: CreatePoolsForFixturesResult[] }> {
  const admin = await requireSuperAdmin();
  const adminClient = createAdminClient();

  const entryFeeCents = parseDollarsToCents(input.entryFee);
  const houseFeeBps = parsePercentToBps(input.houseFeePercent);
  if (entryFeeCents == null || houseFeeBps == null) {
    return { error: "Check the pool configuration — something's missing or invalid.", results: [] };
  }

  const parsed = createPoolsForFixturesSchema.safeParse(
    input.poolType === "TEMPLATE_GRADED"
      ? {
          poolType: "TEMPLATE_GRADED",
          fixtureIds: input.fixtureIds,
          lockMinutesBeforeKickoff: input.lockMinutesBeforeKickoff,
          templateId: input.templateId,
          templateConfig: input.templateConfig ?? {},
          entryFeeCents,
          houseFeeBps,
          visibility: input.visibility,
          participationVisibility: input.participationVisibility,
          overridePublishWarnings: input.overridePublishWarnings ?? false,
        }
      : {
          poolType: input.poolType,
          fixtureIds: input.fixtureIds,
          lockMinutesBeforeKickoff: input.lockMinutesBeforeKickoff,
          entryFeeCents,
          houseFeeBps,
          visibility: input.visibility,
          participationVisibility: input.participationVisibility,
          overridePublishWarnings: input.overridePublishWarnings ?? false,
        },
  );

  if (!parsed.success) {
    return { error: "Check the pool configuration — something's missing or invalid.", results: [] };
  }

  if (parsed.data.poolType === "TEMPLATE_GRADED") {
    const selectedTemplate = getLatestTemplate(parsed.data.templateId);
    const configSchema = selectedTemplate
      ? getTemplateConfigSchema(selectedTemplate.id, selectedTemplate.version)
      : null;
    if (!selectedTemplate || !configSchema) {
      return { error: "Unknown template.", results: [] };
    }
    // Player props bake in one specific fixture's roster (the picked
    // player's external id) — never portable across different fixtures,
    // unlike every other registered template's TEAM_SIDE/INTEGER/BOOLEAN
    // config, which is generic ("home team", "2.5", "yes/no").
    if (selectedTemplate.category === "PLAYER_PROPS") {
      return {
        error: "Player prop templates aren't available when creating pools for multiple fixtures at once.",
        results: [],
      };
    }
    const configParsed = configSchema.safeParse(parsed.data.templateConfig);
    if (!configParsed.success) {
      return { error: "Check the template configuration — something's missing or invalid.", results: [] };
    }
    parsed.data.templateConfig = configParsed.data as Record<string, unknown>;
  }

  const { data: fixtureRows } = await adminClient
    .from("fixtures")
    .select(FIXTURE_SELECT_FOR_POOL_CREATION)
    .in("id", parsed.data.fixtureIds);

  const fixturesById = new Map(
    (fixtureRows ?? []).map((row) => [row.id as string, row as PoolFixtureRow]),
  );

  const results: CreatePoolsForFixturesResult[] = [];
  const publishedPools: CreatedPool[] = [];

  for (const fixtureId of parsed.data.fixtureIds) {
    const fixture = fixturesById.get(fixtureId);
    if (!fixture) {
      results.push({ fixtureId, poolId: null, error: "Fixture not found." });
      continue;
    }

    const locksAt = new Date(
      new Date(fixture.scheduled_start_utc).getTime() - parsed.data.lockMinutesBeforeKickoff * 60_000,
    ).toISOString();

    const outcome = await createPoolForFixture(
      adminClient,
      admin,
      parsed.data as PoolCreationInput,
      fixture,
      locksAt,
      input.publishImmediately,
    );

    if ("warnings" in outcome) {
      results.push({ fixtureId, poolId: null, error: null, warnings: outcome.warnings });
      continue;
    }
    if ("error" in outcome) {
      results.push({ fixtureId, poolId: null, error: outcome.error });
      continue;
    }

    results.push({ fixtureId, poolId: outcome.pool.id, error: null });
    if (input.publishImmediately) publishedPools.push(outcome.pool);
  }

  revalidatePath("/admin/pools");
  if (publishedPools.length > 0) {
    revalidatePath("/feed");
    for (const pool of publishedPools) {
      await notifyFollowersOfPublish(pool);
    }
  }

  return { error: null, results };
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
    await notifyFollowersOfPublish({
      id: poolId,
      question: before.question as string,
      fixtureId: before.fixture_id as string | null,
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
